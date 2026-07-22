import { createClientAsync, type Client } from 'soap';
import amqp, { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import { MongoClient } from 'mongodb';
import { IMVRCase, IMVRCaseDAL, Queues } from '@/types';
import { logger } from '@/utils/logger';

import { veriskUtilsFactory } from '@/utils/verisk-utils';
import { wsdlHandlerFactory } from '@/utils/wsdl-handler';
import { mvrCaseDALFactory } from '@/dal/mvr-case';

import { config } from '@/config';
import { MVRProcessingStatus } from '@/types/enums/mvr-processing-status';
import { veriskCredentialDALFactory } from '@/dal/verisk-credential';
import { IVeriskCredential } from '@/types/interfaces/dal/IVeriskCredentialDAL';

const MAX_VERISK_REQUEST_ID_ATTEMPTS = 10;
const VERISK_REQUEST_ID_POLL_INTERVAL_MS = 4000;
const MIN_PDF_BASE64_LENGTH = 100;

const veriskUtils = veriskUtilsFactory();
const wsdlHandler = wsdlHandlerFactory({
  soapForceIpv4: config.soapForceIpv4,
  soapHttpTimeoutMs: config.soapHttpTimeoutMs,
  wsdlPrefetch: config.wsdlPrefetch,
  wsdlUrl: config.wsdlUrl,
  wsdlDisableCache: config.wsdlDisableCache,
  logger,
  wsdlBrowserHeaders: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/121.0.0.0 Safari/537.36',
    Connection: 'keep-alive',
    Accept: 'text/html,application/xhtml+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
  },
  wsdlLocalPath: config.wsdlLocalPath,
});

async function processMessage(params: {
  payload: IMVRCase;
  veriskCredential: IVeriskCredential;
  mvrCases: IMVRCaseDAL;
  soapClient: Client;
}): Promise<void> {
  if (
    params.payload.caseMVRPaymentStatus === 'Paid By Insured' &&
    params.payload.caseConfirmedPayment === false
  ) {
    logger.info('Skipping Verisk sync — payment not confirmed for insured case', {
      mvrCaseId: params.payload.id,
      caseMVRPaymentStatus: params.payload.caseMVRPaymentStatus,
      caseConfirmedPayment: params.payload.caseConfirmedPayment,
    });
    return;
  }

  const dobStr = veriskUtils.normalizeDobForVerisk(params.payload.driverDateOfBirth);
  const driverPayload = {
    state: params.payload.driverLicenseState,
    dl: params.payload.driverLicenseNumber,
    lastName: params.payload.driverLastName,
    firstName: params.payload.driverFirstName,
    dob: dobStr,
  };

  const missingRequiredFields = (['state', 'dl', 'lastName', 'firstName', 'dob'] as const).filter(
    (key) => !driverPayload[key],
  );

  if (missingRequiredFields.length > 0) {
    logger.error('Missing required fields', {
      mvrCaseId: params.payload.id,
      missingRequiredFields,
    });

    await params.mvrCases.updateMVRCaseStatus(params.payload.id, MVRProcessingStatus.FAILED_VERISK_SYNC);
    logger.info('Updated MVR case status to FAILED_VERISK_SYNC', { mvrCaseId: params.payload.id });
    return;
  }

  const driverRequestPayload = veriskUtils.buildMvrRequest(driverPayload, {
    user: params.veriskCredential.user,
    password: params.veriskCredential.password,
    account: params.veriskCredential.account,
  });

  try {
    const [sendResult] = await params.soapClient.sendRequest2Async({ arg0: driverRequestPayload });
    const acceptResponse = veriskUtils.extractResponseString(sendResult);

    if (!acceptResponse || !acceptResponse.startsWith('Accept:')) {
      logger.error('Failed to extract Verisk request ID', { sendResult });

      await params.mvrCases.updateMVRCaseStatus(params.payload.id, MVRProcessingStatus.FAILED_VERISK_SYNC);

      logger.info('Updated MVR case status to FAILED_VERISK_SYNC', { mvrCaseId: params.payload.id });
      return;
    }

    const requestId = acceptResponse.substring(7, 16);
    logger.info('Verisk request ID extracted', { requestId, acceptResponse });

    await params.mvrCases.updateMVRCaseRequestIdVerisk(params.payload.id, requestId);
    await params.mvrCases.updateMVRCaseRequestStrVerisk(params.payload.id, driverRequestPayload);

    const pollString = veriskUtils.buildPdfPollString(requestId, params.veriskCredential);
    let pdfReceived = false;
    let attempts = 0;

    while (attempts < MAX_VERISK_REQUEST_ID_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, VERISK_REQUEST_ID_POLL_INTERVAL_MS));
      attempts++;

      logger.info(`Attempt ${attempts}/${MAX_VERISK_REQUEST_ID_ATTEMPTS} to poll for PDF...`);

      try {
        const [res] = await params.soapClient.getPdfResponse2Async({ arg0: pollString });
        const responseText = veriskUtils.extractResponseString(res);

        if (responseText.startsWith('Error:')) {
          if (responseText.includes('not yet available')) {
            logger.info('Server processing...');
            continue;
          }
          throw new Error(`Error from service: ${responseText}`);
        }

        if (responseText.length > MIN_PDF_BASE64_LENGTH) {
          logger.info('PDF Base64 Received!');

          await params.mvrCases.updateMVRCaseBase64PDF(params.payload.id, responseText);
          await params.mvrCases.updateMVRCaseStatus(
            params.payload.id,
            MVRProcessingStatus.COMPLETED_VERISK_SYNC,
          );

          logger.info('Updated MVR case with Verisk PDF and COMPLETED_VERISK_SYNC', {
            mvrCaseId: params.payload.id,
            base64Length: responseText.length,
          });
          pdfReceived = true;
          break;
        }

        throw new Error('Timeout waiting for PDF');
      } catch (error) {
        logger.error('Failed to poll for PDF', { error });

        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('not yet available')) {
          logger.info('Server processing...');
          continue;
        }

        throw error;
      }
    }

    if (!pdfReceived) {
      throw new Error('Timeout waiting for PDF');
    }
  } catch (error) {
    logger.error('Failed to send request to Verisk', { error });
    await params.mvrCases.updateMVRCaseStatus(params.payload.id, MVRProcessingStatus.FAILED_VERISK_SYNC);
    logger.info('Updated MVR case status to FAILED_VERISK_SYNC', { mvrCaseId: params.payload.id });
    return;
  }
}

async function startConsumer(): Promise<void> {
  const rabbitmqUri = config.rabbitmqUri;
  const mongoDBUri = config.mongoDBUri;

  if (!rabbitmqUri) {
    throw new Error('RABBITMQ_URI is required');
  }

  if (!mongoDBUri) {
    throw new Error('MONGO_DB_URI is required');
  }

  const soapClientOptions = wsdlHandler.buildSoapClientOptions();
  const wsdl = await wsdlHandler.resolveWsdlLocationForSoap();

  const soapClient: Client = await createClientAsync(wsdl, soapClientOptions);

  if (!soapClient) {
    throw new Error('Failed to create SOAP client');
  }

  const mongoClient = new MongoClient(mongoDBUri);
  await mongoClient.connect();

  const mongoDB = mongoClient.db();

  const mvrCases = mvrCaseDALFactory(mongoDB);
  const veriskCredentials = veriskCredentialDALFactory(mongoDB);
  logger.info('MongoDB connected; MVR case DAL ready');

  const activeVeriskCredential = await veriskCredentials.getActiveVeriskCredentials();

  if (!activeVeriskCredential) {
    throw new Error('No active Verisk credential found');
  }

  const connection: ChannelModel = await amqp.connect(rabbitmqUri);
  const channel: Channel = await connection.createChannel();

  await channel.assertQueue(Queues.GET_DRIVER_VERISK, { durable: true });
  channel.prefetch(1);

  logger.info(`Waiting for messages on queue: ${Queues.GET_DRIVER_VERISK}`);

  await channel.consume(
    Queues.GET_DRIVER_VERISK,
    async (message: ConsumeMessage | null) => {
      if (!message) return;

      try {
        const payload: IMVRCase = JSON.parse(message.content.toString());
        logger.info('Received message from get-driver-verisk-queue', { payload });

        await processMessage({
          payload,
          mvrCases,
          soapClient,
          veriskCredential: activeVeriskCredential,
        });

        channel.ack(message);
      } catch (error) {
        logger.error('Failed to process Verisk message', { error });
        channel.nack(message, false, false);
      }
    },
    { noAck: false },
  );

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down consumer`);
    try {
      await channel.close();
      await connection.close();
      await mongoClient.close();
    } catch (error) {
      console.error('Error during consumer shutdown', error);
      logger.error('Error during consumer shutdown', { error });
    }
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

startConsumer().catch((error) => {
  // Ensure Railway/Docker always see the failure even if Winston buffers
  console.error('Failed to start Verisk consumer', error);
  logger.error('Failed to start Verisk consumer', { error });
  process.exit(1);
});
