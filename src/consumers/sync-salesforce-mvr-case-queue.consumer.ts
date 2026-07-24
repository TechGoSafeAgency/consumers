import axios from 'axios';
import { logger } from '@/utils/logger';
import { config } from '@/config';
import { MongoClient } from 'mongodb';
import { mvrCaseDALFactory } from '@/dal/mvr-case';
import amqp, { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import { IMVRCase, IMVRCaseDAL, ISyncMVRCaseLogDAL, Queues } from '@/types';
import { createClient } from 'redis';
import { salesforceHandlerFactory } from '@/utils/salesforce-handler';
import {
  ISalesforceEmailPayload,
  ISalesforceResponse,
  ISalesforceError,
  ISalesforceHandler,
  ISalesforceEmailAttachmentPayload,
  ISalesforceEmailSimplePayload,
  ISalesforceCasePayload,
} from '@/types/interfaces/ISalesforceHandler';
import { syncMVRCaseLogDALFactory } from '@/dal/sync-mvr-case-log';
import moment from 'moment';
import { MVRProcessingStatus } from '@/types/enums/mvr-processing-status';

const COMPLETED_CASE_APPROVAL_STATUS = 'Completed';
const MIN_PDF_BASE64_LENGTH = 100;
const SERVICE_NAME = 'sync-salesforce-mvr-case-queue';

const VERISK_PIPELINE_COMPLETE_FOR_CASE_GATE = new Set<string>([
  MVRProcessingStatus.COMPLETED_VERISK_SYNC,
  MVRProcessingStatus.SALESFORCE_PDF_SYNCED,
]);

function isMvrCaseVeriskReadyForCaseApproval(doc: IMVRCase): boolean {
  if (!doc.processingStatus || !VERISK_PIPELINE_COMPLETE_FOR_CASE_GATE.has(doc.processingStatus)) {
    return false;
  }

  const hasPdf = typeof doc.base64PDF === 'string' && doc.base64PDF.trim().length > 0;
  const hasRequestId = doc.requestIdVerisk != null && String(doc.requestIdVerisk).trim() !== '';
  return hasPdf && hasRequestId;
}

async function authenticateSalesforce(params: {
  authAppKey: string;
  appAuthId: string;
  appAuthSecret: string;
  authApiUrl: string;
  mongoDBUri: string;
  application: string;
}): Promise<string> {
  const requiredVars = [
    { name: 'AUTH_APP_KEY', value: params.authAppKey },
    { name: 'APP_AUTH_ID', value: params.appAuthId },
    { name: 'APP_AUTH_SECRET', value: params.appAuthSecret },
    { name: 'AUTH_API_URL', value: params.authApiUrl },
    { name: 'MONGO_DB_URI', value: params.mongoDBUri },
  ];

  const missing = requiredVars.filter((r) => !r.value?.trim()).map((r) => r.name);
  if (missing.length) {
    throw new Error(`Missing or empty required env: ${missing.join(', ')}`);
  }

  try {
    const getResponse = await axios.get(`${params.authApiUrl}/auth/salesforce-token`, {
      headers: {
        'x-auth-app': params.authAppKey,
        'x-salesforce-auth-id': params.appAuthId,
        'x-salesforce-auth-secret': params.appAuthSecret,
      },
      validateStatus: () => true,
    });

    if (getResponse.status === 200 && getResponse.data?.data?.token) {
      return getResponse.data.data.token as string;
    }

    logger.info('⏭️ Salesforce token GET did not return a token; trying POST fallback');

    const postResponse = await axios.post(
      `${params.authApiUrl}/auth/salesforce-token`,
      { application: params.application },
      { validateStatus: () => true },
    );

    if (postResponse.status === 200 && postResponse.data?.data?.token) {
      return postResponse.data.data.token as string;
    }

    throw new Error('Failed to authenticate Salesforce');
  } catch (error: any) {
    logger.error('❌ Failed to authenticate Salesforce', { error });
    throw new Error(`authentication error: ${error.message}`);
  }
}

async function recordSalesforceFailure(params: {
  syncMVRCaseLog: ISyncMVRCaseLogDAL;
  mvrCases: IMVRCaseDAL;
  id: string;
  salesforceCaseId?: string;
  error: ISalesforceError;
  message: string;
}): Promise<void> {
  const { syncMVRCaseLog, mvrCases, id, salesforceCaseId, error, message } = params;

  await syncMVRCaseLog.createSyncMVRCaseLog({
    serviceName: SERVICE_NAME,
    success: false,
    error: message,
    metadata: error,
    createdDate: moment.utc().format('YYYY-MM-DD HH:mm:ss'),
  });

  await mvrCases.updateMVRCaseStatus(id, MVRProcessingStatus.FAILED_SYNC_MVR_PDF_SALESFORCE);

  await mvrCases.pushAuditTrail(id, {
    action: 'sync-mvr-pdf-salesforce',
    processingStatus: MVRProcessingStatus.FAILED_SYNC_MVR_PDF_SALESFORCE,
    timestamp: moment.utc().format('YYYY-MM-DD HH:mm:ss'),
    user: 'system',
    details: {
      caseId: salesforceCaseId ?? id,
      errorCode: error.errorCode,
      errorMessage: error.message,
      responseData: error.raw,
      message,
    },
  });
}

async function processMessage(params: {
  payload: Pick<IMVRCase, 'id' | 'base64PDF'>;
  mvrCases: IMVRCaseDAL;
  syncMVRCaseLog: ISyncMVRCaseLogDAL;
  salesforceHandler: ISalesforceHandler;
  salesforceAuthToken: string;
}) {
  try {
    const { payload, mvrCases, syncMVRCaseLog, salesforceHandler, salesforceAuthToken } = params;
    const { id, base64PDF } = payload;

    if (!id) {
      throw new Error('MVR case ID is required');
    }

    if (!base64PDF || base64PDF.length <= MIN_PDF_BASE64_LENGTH) {
      throw new Error('Valid base64 PDF is required');
    }

    const mvrCase = await mvrCases.getMVRCaseById(id);

    if (!mvrCase) {
      throw new Error('MVR case not found');
    }

    if (!mvrCase.id || !mvrCase.caseId || !mvrCase.requestIdVerisk || String(mvrCase.requestIdVerisk).trim() === '') {
      logger.error('❌ MVR case is not ready for Salesforce sync, missing required fields', { mvrCase });
      throw new Error('MVR case is not ready for Salesforce sync');
    }

    logger.info('✅ MVR case is ready for Salesforce sync', { id: mvrCase.id, caseId: mvrCase.caseId });

    const emailPayload: ISalesforceEmailPayload = {
      ParentId: mvrCase.caseId,
      Subject: 'MVR PDF Attached',
      TextBody: 'You will find the PDF attached.',
      Status: config.emailStatus,
      ToAddress: `${config.emailNotificationsTo}, ${mvrCase.producerOwnerEmail}`,
      FromAddress: config.emailSimpleSenderAddress,
    };

    const responseEmailSF: ISalesforceError | ISalesforceResponse =
      await salesforceHandler.postSalesforceEmailMessage({
        salesforceAuthToken,
        emailPayload,
      });

    if (!('id' in responseEmailSF)) {
      logger.error('❌ Failed to post Salesforce email message', { responseEmailSF });
      await recordSalesforceFailure({
        syncMVRCaseLog,
        mvrCases,
        id,
        salesforceCaseId: mvrCase.caseId,
        error: responseEmailSF,
        message: 'Failed to post Salesforce email message',
      });
      throw new Error(`Failed to post Salesforce email message: ${responseEmailSF.message}`);
    }

    logger.info('✅ Salesforce email message posted successfully', { responseEmailSF });

    const attachmentPayload: ISalesforceEmailAttachmentPayload = {
      ParentId: responseEmailSF.id,
      Name: `${moment.utc().format('YYYYDDMM')}-MVR-${mvrCase.driverFirstName}-${mvrCase.driverLastName}.pdf`,
      Body: base64PDF,
      ContentType: 'application/pdf',
    };

    const responseAttachmentSF: ISalesforceError | ISalesforceResponse =
      await salesforceHandler.postSalesforceEmailAttachment({
        salesforceAuthToken,
        attachmentPayload,
      });

    if (!('id' in responseAttachmentSF)) {
      logger.error('❌ Failed to post Salesforce email attachment', { responseAttachmentSF });
      await recordSalesforceFailure({
        syncMVRCaseLog,
        mvrCases,
        id,
        salesforceCaseId: mvrCase.caseId,
        error: responseAttachmentSF,
        message: 'Failed to post Salesforce email attachment',
      });
      throw new Error(`Failed to post Salesforce email attachment: ${responseAttachmentSF.message}`);
    }

    logger.info('✅ Salesforce email attachment posted successfully', { responseAttachmentSF });

    if (config.emailSimpleSenderType === 'OrgWideEmailAddress' && !config.emailSimpleSenderAddress.trim()) {
      logger.error('❌ EMAIL_SIMPLE_SENDER_ADDRESS is required when EMAIL_SIMPLE_SENDER_TYPE=OrgWideEmailAddress', {
        mvrCaseId: id,
      });
      await recordSalesforceFailure({
        syncMVRCaseLog,
        mvrCases,
        id,
        salesforceCaseId: mvrCase.caseId,
        error: {
          message: 'emailSimple config: missing EMAIL_SIMPLE_SENDER_ADDRESS for OrgWideEmailAddress',
          raw: null,
        },
        message: 'emailSimple config: missing EMAIL_SIMPLE_SENDER_ADDRESS for OrgWideEmailAddress',
      });
      throw new Error('EMAIL_SIMPLE_SENDER_ADDRESS is required when EMAIL_SIMPLE_SENDER_TYPE=OrgWideEmailAddress');
    }

    const recipientList = [config.emailNotificationsTo, mvrCase.producerOwnerEmail]
      .filter((e) => e != null && String(e).trim() !== '')
      .join(', ');

    const emailSimplePayload: ISalesforceEmailSimplePayload = {
      emailAddresses: recipientList,
      emailSubject: `MVR PDF Attached - Case: ${mvrCase.caseNumber ?? mvrCase.caseId}`,
      emailBody:
        'You will find the PDF attached.\n\n' +
        (responseEmailSF.id ? `Related EmailMessage Id (CRM log): ${responseEmailSF.id}` : ''),
      senderType: config.emailSimpleSenderType,
      attachmentId: responseAttachmentSF.id,
      relatedRecordId: mvrCase.caseId,
      logEmailOnSend: config.emailSimpleLogOnSend && mvrCase.caseId ? true : false,
      senderAddress:
        config.emailSimpleSenderType === 'OrgWideEmailAddress'
          ? config.emailSimpleSenderAddress.trim()
          : undefined,
    };

    const responseEmailSimpleSF: ISalesforceError | ISalesforceResponse =
      await salesforceHandler.postSalesforceEmailSimple({
        salesforceAuthToken,
        emailSimplePayload,
      });

    if (!('id' in responseEmailSimpleSF)) {
      logger.error('❌ Failed to post Salesforce email simple', { responseEmailSimpleSF });
      await recordSalesforceFailure({
        syncMVRCaseLog,
        mvrCases,
        id,
        salesforceCaseId: mvrCase.caseId,
        error: responseEmailSimpleSF,
        message: 'Failed to post Salesforce email simple',
      });
      throw new Error(`Failed to post Salesforce email simple: ${responseEmailSimpleSF.message}`);
    }

    logger.info('✅ Salesforce email simple posted successfully', { responseEmailSimpleSF });

    const siblingMvrCases = await mvrCases.getSiblingMvrCases(mvrCase.caseId, mvrCase.caseNumber);
    const notReady = siblingMvrCases.filter((sibling) => !isMvrCaseVeriskReadyForCaseApproval(sibling));
    const allReady = siblingMvrCases.length > 0 && notReady.length === 0;
    let caseApprovalPatchedToSalesforce = false;

    if (!allReady) {
      logger.info('⏭️ Skipping Case Approval_Status__c — not all sibling drivers are Verisk-ready yet', {
        caseId: mvrCase.caseId,
        caseNumber: mvrCase.caseNumber,
        siblingCount: siblingMvrCases.length,
        notReadyCount: notReady.length,
        notReadyIds: notReady.map((d) => d.id),
      });
    } else {
      const caseApprovalPayload: ISalesforceCasePayload = {
        Approval_Status__c: COMPLETED_CASE_APPROVAL_STATUS,
      };

      const responseCaseApprovalSF: ISalesforceError | ISalesforceResponse =
        await salesforceHandler.patchSalesforceCaseApprovalStatus({
          salesforceAuthToken,
          caseId: mvrCase.caseId,
          casePayload: caseApprovalPayload,
        });

      if (!('id' in responseCaseApprovalSF)) {
        logger.error('❌ Failed to patch Salesforce case approval status', { responseCaseApprovalSF });
        await recordSalesforceFailure({
          syncMVRCaseLog,
          mvrCases,
          id,
          salesforceCaseId: mvrCase.caseId,
          error: responseCaseApprovalSF,
          message: 'Failed to patch Salesforce case approval status',
        });
        throw new Error(`Failed to patch Salesforce case approval status: ${responseCaseApprovalSF.message}`);
      }

      caseApprovalPatchedToSalesforce = true;
      logger.info('✅ Salesforce case approval status patched successfully', { responseCaseApprovalSF });
    }

    await mvrCases.updateMVRCaseApprovalStatus({
      id: mvrCase.id,
      caseApprovalStatus: COMPLETED_CASE_APPROVAL_STATUS,
      processingStatus: MVRProcessingStatus.SALESFORCE_PDF_SYNCED,
      emailMessageId: responseEmailSF.id,
      attachmentId: responseAttachmentSF.id,
      caseApprovalPatchedToSalesforce,
      caseNumber: mvrCase.caseNumber,
      ...(!allReady
        ? {
            caseApprovalDeferredReason: 'pending_sibling_mvr_drivers',
            notReadySiblingIds: notReady.map((d) => d.id),
          }
        : {}),
    });

    logger.info('✅ MVR case marked SALESFORCE-PDF-SYNCED', {
      id: mvrCase.id,
      caseApprovalPatchedToSalesforce,
    });

    await syncMVRCaseLog.createSyncMVRCaseLog({
      serviceName: SERVICE_NAME,
      success: true,
      error: null,
      metadata: {
        id: mvrCase.id,
        caseId: mvrCase.caseId,
        emailMessageId: responseEmailSF.id,
        attachmentId: responseAttachmentSF.id,
        caseApprovalPatchedToSalesforce,
      },
      createdDate: moment.utc().format('YYYY-MM-DD HH:mm:ss'),
    });
  } catch (error: any) {
    logger.error('❌ Failed to process message', { error });
    throw new Error(`processing error: ${error.message}`);
  }
}

async function startConsumer(): Promise<void> {
  const rabbitmqUri = config.rabbitmqUri;
  const mongoDBUri = config.mongoDBUri;
  const salesforceBaseUrl = config.salesforceBaseUrl;
  const salesforceApiVersion = config.sfApiVersion;
  const redisUri = config.redisUri;
  const emailSimpleSenderAddress = config.emailSimpleSenderAddress;
  const emailNotificationsTo = config.emailNotificationsTo;
  const emailSimpleSenderType = config.emailSimpleSenderType;

  if (!emailSimpleSenderType) {
    throw new Error('EMAIL_SIMPLE_SENDER_TYPE is not set');
  }

  if (!emailNotificationsTo) {
    throw new Error('EMAIL_NOTIFICATIONS_TO is not set');
  }

  if (!rabbitmqUri) {
    throw new Error('RABBITMQ_URI is not set');
  }

  if (!mongoDBUri) {
    throw new Error('MONGO_DB_URI is not set');
  }

  if (!salesforceBaseUrl) {
    throw new Error('SALESFORCE_BASE_URL is not set');
  }

  if (!salesforceApiVersion) {
    throw new Error('SALESFORCE_API_VERSION is not set');
  }

  if (!redisUri) {
    throw new Error('REDIS_URI is not set');
  }

  const mongoClient = new MongoClient(mongoDBUri);
  await mongoClient.connect();
  logger.info('🚀 MongoDB connected');

  const mongoDB = mongoClient.db();
  const mvrCases = mvrCaseDALFactory(mongoDB);
  const syncMVRCaseLog = syncMVRCaseLogDALFactory(mongoDB);

  const redisClient = createClient({ url: redisUri });
  await redisClient.connect();
  logger.info('🚀 Redis connected');

  let salesforceAuthToken = '';
  const cachedSalesforceAuthToken = await redisClient.get('salesforce-auth-token');

  if (cachedSalesforceAuthToken) {
    logger.info('✅ Salesforce auth token found in cache');
    salesforceAuthToken = cachedSalesforceAuthToken;
  } else {
    salesforceAuthToken = await authenticateSalesforce({
      authAppKey: config.authAppKey,
      appAuthId: config.appAuthId,
      appAuthSecret: config.appAuthSecret,
      authApiUrl: config.authApiUrl,
      mongoDBUri,
      application: config.application,
    });

    await redisClient.set('salesforce-auth-token', salesforceAuthToken, { EX: 1200 });
    logger.info('✅ Salesforce auth token set');
  }

  const axiosInstance = axios.create({
    baseURL: salesforceBaseUrl,
  });

  const salesforceHandler = salesforceHandlerFactory({
    axiosInstance,
    salesforceApiVersion,
  });

  const connection: ChannelModel = await amqp.connect(rabbitmqUri);
  const channel: Channel = await connection.createChannel();

  await channel.assertQueue(Queues.SYNC_SALESFORCE_MVR_CASE_PDF, { durable: true });
  channel.prefetch(1);

  logger.info(`⏳ Waiting for messages on queue: ${Queues.SYNC_SALESFORCE_MVR_CASE_PDF}`);

  await channel.consume(
    Queues.SYNC_SALESFORCE_MVR_CASE_PDF,
    async (message: ConsumeMessage | null) => {
      if (!message) return;

      try {
        const payload: Pick<IMVRCase, 'id' | 'base64PDF'> = JSON.parse(message.content.toString());
        logger.info('📥 Received message from sync-salesforce-mvr-case-pdf-queue', {
          id: payload.id,
          base64Length: payload.base64PDF?.length,
        });

        await processMessage({
          payload,
          mvrCases,
          syncMVRCaseLog,
          salesforceHandler,
          salesforceAuthToken,
        });

        channel.ack(message);
      } catch (error) {
        logger.error('❌ Failed to process message from sync-salesforce-mvr-case-pdf-queue', { error });
        channel.nack(message, false, false);
      }
    },
    { noAck: false },
  );

  const shutdown = async (signal: string) => {
    logger.info(`⏭️ Received ${signal}, shutting down consumer`);
    try {
      await channel.close();
      await connection.close();
      await mongoClient.close();
      await redisClient.quit();
    } catch (error) {
      console.error('❌ Error during consumer shutdown', error);
      logger.error('❌ Error during consumer shutdown', { error });
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
  console.error('❌ Failed to start Salesforce MVR Case PDF Sync consumer', error);
  logger.error('❌ Failed to start Salesforce MVR Case PDF Sync consumer', { error });
  process.exit(1);
});
