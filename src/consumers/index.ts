import axios from 'axios';
import moment from 'moment-timezone';
import { createClient } from 'redis';
import {
  MongoClient,
  type Collection,
  type Document,
  type UpdateFilter,
} from 'mongodb@6.21.0';
import bunyan from 'bunyan';

const SF_BASE_PATH = "https://gosafe.my.salesforce.com";
const MONGO_DB_URI  = process.env.MONGO_DB_URI ?? '';
const REDIS_URI = process.env.REDIS_URI ?? '';
const MVR_CASES_COLLECTION = process.env.MVR_CASES_COLLECTION ?? 'mvr_cases';
const SYNC_MVR_CASES_LOG_COLLECTION = process.env.SYNC_MVR_CASES_LOG_COLLECTION ?? 'sync_mvr_cases_log';
const TO_ADDRESS = process.env.TO_ADDRESS ?? 'finances@gosafeagency.com';
const IS_PRODUCTION = process.env.IS_PRODUCTION && process.env.IS_PRODUCTION === 'true' ? true : false;
const RAILWAY_SERVICE_NAME = process.env.RAILWAY_SERVICE_NAME ?? 'salesforce-mvr-pdf-sync';

const AUTH_APP_KEY = process.env.AUTH_APP_KEY ?? '';
const APP_AUTH_ID = process.env.APP_AUTH_ID ?? '';
const APP_AUTH_SECRET = process.env.APP_AUTH_SECRET ?? '';
const APPLICATION = process.env.APPLICATION ?? 'SERVERLESS-SYNC-MVR-CASES';

const AUTH_API_URL = process.env.AUTH_API_URL ?? '';

const FAILED_SYNC_MVR_PDF_SALESFORCE_STATUS = 'FAILED-SYNC-MVR-PDF-SALESFORCE';
const FILTER_PROCESSING_STATUS = 'COMPLETED-VERISK-SYNC';
const UPDATE_PROCESSING_STATUS = 'SALESFORCE-PDF-SYNCED';
const EMAIL_STATUS = '3';
const COMPLETED_CASE_APPROVAL_STATUS = 'Completed';
const EMAIL_SIMPLE_SENDER_TYPE = process.env.EMAIL_SIMPLE_SENDER_TYPE ?? 'CurrentUser';
/** Required when EMAIL_SIMPLE_SENDER_TYPE is OrgWideEmailAddress (org-wide address or Id — match your org). */
const EMAIL_SIMPLE_SENDER_ADDRESS = process.env.EMAIL_SIMPLE_SENDER_ADDRESS ?? '';
const SF_API_VERSION = process.env.SF_API_VERSION ?? 'v53.0';
/** Log outbound email on Case activity when using emailSimple (describe: relatedRecordId + logEmailOnSend). */
const EMAIL_SIMPLE_LOG_ON_SEND =
  process.env.EMAIL_SIMPLE_LOG_ON_SEND !== 'false' &&
  process.env.EMAIL_SIMPLE_LOG_ON_SEND !== '0';

const CASE_ID_TEST = '500Pm00001P4u4oIAB';
const DRIVER_NAME_TEST = 'Gustavo-Andrade'
const BASE64_PDF_TEST = "JVBERi0xLjQKJeLjz9MKMSAwe...";

const FROM_ADDRESS = process.env.FROM_ADDRESS ?? 'carolina@gosafeagency.com';

const logger = bunyan.createLogger({
  name: RAILWAY_SERVICE_NAME,
  level: process.env.LOG_LEVEL || 'info',
  stream: process.stdout,
  serializers: {
    err: bunyan.stdSerializers.err,
    req: bunyan.stdSerializers.req,
    res: bunyan.stdSerializers.res
  },
  src: process.env.NODE_ENV !== 'production'
});

/** Axios/Error objects contain circular refs; BSON cannot serialize them for MongoDB. */
function toMongoSafeErrorMetadata(err: unknown): Record<string, unknown> {
  if (axios.isAxiosError(err)) {
    return {
      name: err.name,
      message: err.message,
      code: err.code,
      status: err.response?.status,
      statusText: err.response?.statusText,
      responseData: err.response?.data,
      stack: err.stack,
    };
  }
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  try {
    return JSON.parse(JSON.stringify(err)) as Record<string, unknown>;
  } catch {
    return { value: String(err) };
  }
}

function extractSalesforceError(data: unknown): { message: string; errorCode?: string; raw: unknown } | null {
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0] as { message?: string; errorCode?: string };
    if (first?.message || first?.errorCode) {
      return {
        message: first.message ?? 'Unknown Salesforce error',
        errorCode: first.errorCode,
        raw: data,
      };
    }
  }
  if (data && typeof data === 'object') {
    const obj = data as { message?: string; error?: unknown };
    if (typeof obj.message === 'string') {
      return {
        message: obj.message,
        raw: data,
      };
    }
    if (obj.error) {
      return {
        message: 'Salesforce returned an error object',
        raw: obj.error,
      };
    }
  }
  return null;
}

/**
 * Invocable POST often returns HTTP 200 with body `{ results: [{ isSuccess, errors }] }`.
 * Treat isSuccess === false as failure even when status is 200.
 */
function extractEmailSimpleInvokeError(
  data: unknown,
): { message: string; raw: unknown } | null {
  if (!data || typeof data !== 'object') return null;
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results) || results.length === 0) return null;
  const first = results[0] as { isSuccess?: boolean; errors?: unknown };
  if (first.isSuccess !== false) return null;
  const errs = first.errors;
  if (Array.isArray(errs) && errs.length > 0) {
    const e0 = errs[0] as { message?: string; statusCode?: string };
    return {
      message: e0.message ?? 'emailSimple returned isSuccess false',
      raw: data,
    };
  }
  return { message: 'emailSimple returned isSuccess false', raw: data };
}

/** Verisk pull finished and PDF sync job may run (current row or already emailed in a prior run). */
const VERISK_PIPELINE_COMPLETE_FOR_CASE_GATE = new Set<string>([
  FILTER_PROCESSING_STATUS,
  UPDATE_PROCESSING_STATUS,
]);

function hasNonEmptyBase64Pdf(doc: { base64PDF?: unknown }): boolean {
  return (
    typeof doc.base64PDF === "string" && doc.base64PDF.trim().length > 0
  );
}

function hasRequestIdVerisk(doc: { requestIdVerisk?: unknown }): boolean {
  const rid = doc.requestIdVerisk;
  return rid != null && String(rid).trim() !== "";
}

/** Every driver row for the Case must be at Verisk-complete with PDF + request id before Case approval. */
function isMvrCaseVeriskReadyForCaseApproval(doc: any): boolean {
  if (
    !doc?.processingStatus ||
    !VERISK_PIPELINE_COMPLETE_FOR_CASE_GATE.has(doc.processingStatus)
  ) {
    return false;
  }
  return hasNonEmptyBase64Pdf(doc) && hasRequestIdVerisk(doc);
}

function siblingCaseFilter(
  caseId: string,
  caseNumber: unknown
): Record<string, string> {
  const filter: Record<string, string> = { caseId };
  if (caseNumber != null && String(caseNumber).trim() !== "") {
    filter.caseNumber = String(caseNumber);
  }
  return filter;
}

async function allSiblingMvrCasesReadyForSalesforceCaseApproval(
  collection: Collection<Document>,
  caseId: string,
  caseNumber: unknown
): Promise<{ allReady: boolean; siblings: any[]; notReady: any[] }> {
  const filter = siblingCaseFilter(caseId, caseNumber);
  const siblings = await collection.find(filter).toArray();
  const notReady = siblings.filter(
    (s) => !isMvrCaseVeriskReadyForCaseApproval(s)
  );
  return {
    allReady: siblings.length > 0 && notReady.length === 0,
    siblings,
    notReady,
  };
}

async function authenticateSalesforce() {
  try {
    const requiredVars = [
      { name: 'AUTH_APP_KEY', value: AUTH_APP_KEY },
      { name: 'APP_AUTH_ID', value: APP_AUTH_ID },
      { name: 'APP_AUTH_SECRET', value: APP_AUTH_SECRET },
      { name: 'AUTH_API_URL', value: AUTH_API_URL },
      { name: 'MONGO_DB_URI', value: MONGO_DB_URI },
    ] as const;
    const missing = requiredVars.filter((r) => !r.value?.trim()).map((r) => r.name);

    if (missing.length) {
      throw new Error(`Missing or empty required env: ${missing.join(', ')}`);
    }

    let response: any = null;

    response = await axios.get(
      `${AUTH_API_URL}/auth/salesforce-token`,
      {
        headers: {
          'x-auth-app': AUTH_APP_KEY,
          'x-salesforce-auth-id': APP_AUTH_ID,
          'x-salesforce-auth-secret': APP_AUTH_SECRET,
        },
      }
    );

    if (response && response.data && response.data.data && response.data.data.token && response.status === 200) {
      return response.data.data.token;
    } else {
      response = await axios.post(
        `${AUTH_API_URL}/auth/salesforce-token`,
        {
          application: APPLICATION,
        },
      );

      if (response && response.data && response.data.data && response.data.data.token && response.status === 200) {
        return response.data.data.token;
      } else {
        throw new Error('Failed to authenticate Salesforce');
      }
    }
  } catch (error: any) {
    console.error('Error:', {
      responseData: error.response?.data,
      bunVersion: Bun.version
    });
    throw new Error(`authentication error: ${error.message}`);
  }
}

(async () => {

  if (!MONGO_DB_URI) {
    logger.error('❌ MONGO_DB_URI is not set');
    return;
  }

  if (!REDIS_URI) {
    logger.error('❌ REDIS_URI is not set');
    return;
  }

  const redisClient = createClient({
    url: REDIS_URI,
  });
  const mongoClient = new MongoClient(MONGO_DB_URI);
  logger.info('function execution started');

  try {
    await mongoClient.connect();
    logger.info('connected to MongoDB');

    await redisClient.connect();
    logger.info('connected to Redis');

    let token = '';
    const cachedToken = await redisClient.get('salesforce-auth-token');
    
    if (cachedToken) {
      logger.info('salesforce auth token found in cache');
      token = cachedToken;
    } else {
      token = await authenticateSalesforce();
      await redisClient.set('salesforce-auth-token', token, { EX: 1200 });
      logger.info('salesforce auth token set');
    }

    logger.info('authentication successful');

    const collection = mongoClient.db().collection(MVR_CASES_COLLECTION);

    if (IS_PRODUCTION) {
      logger.info("🔍 Production environment detected");
      const mvrCases = await collection.find({
        processingStatus: FILTER_PROCESSING_STATUS,
        createdDate: { $gte: new Date("2026-04-15")}
      }, {
        projection: {
          id: 1,
          caseId: 1,
          caseNumber: 1,
          driverFirstName: 1,
          driverLastName: 1,
          base64PDF: 1,
          requestIdVerisk: 1,
          processingStatus: 1,
          producerOwnerEmail: 1,
        },
        limit: 20,
        sort: { createdDate: -1 }
      }).toArray();

      logger.info(`[PRODUCTION] ✅ ${mvrCases.length} mvr cases found`);

      if (!mvrCases || !mvrCases.length) {
        logger.info("[PRODUCTION] ❌ No mvr cases found");
        return;
      }

      for (const mvrCase of mvrCases) {
        const {
          id,
          caseId,
          caseNumber,
          base64PDF,
          driverFirstName,
          driverLastName,
          requestIdVerisk,
          producerOwnerEmail,
        } = mvrCase;

        if (!base64PDF) {
          logger.info(`[PRODUCTION] ❌ No base64PDF found for mvr case: ${id}`);
          continue;
        }

        if (!id || !caseId) {
          logger.info(`[PRODUCTION] ❌ No id found for mvr case`);
          continue;
        }

        if (!requestIdVerisk || String(requestIdVerisk).trim() === "") {
          logger.info(
            `[PRODUCTION] ❌ No requestIdVerisk for mvr case: ${id} — skipping Salesforce sync`
          );
          continue;
        }

        logger.info(`[PRODUCTION] ✅ Sending email for MVR case: ${caseId}`);

        const emailPayload = {
          ParentId: caseId,
          Subject: "MVR PDF Attached",
          TextBody: "You will find the PDF attached.",
          Status: EMAIL_STATUS,
          ToAddress: `${TO_ADDRESS}, ${producerOwnerEmail}`,
          FromAddress: FROM_ADDRESS
        };

        const responseEmailSF = await axios.post(
          `${SF_BASE_PATH}/services/data/${SF_API_VERSION}/sobjects/EmailMessage`,
          emailPayload,
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            validateStatus: () => true,
          }
        );

        const emailSfError = extractSalesforceError(responseEmailSF.data);
        
        if (responseEmailSF.status >= 400 || emailSfError) {
          logger.error(`[PRODUCTION] ❌ Error sending email for MVR case: ${caseId}`);
          logger.error({
            status: responseEmailSF.status,
            statusText: responseEmailSF.statusText,
            errorCode: emailSfError?.errorCode,
            errorMessage: emailSfError?.message,
            responseData: responseEmailSF.data,
          });

          const syncMvrCasesLogCollection = mongoClient.db().collection(SYNC_MVR_CASES_LOG_COLLECTION);
          await syncMvrCasesLogCollection.insertOne({
            serviceName: RAILWAY_SERVICE_NAME,
            success: false,
            error: 'Error sending email for MVR case to Salesforce',
            metadata: {
              caseId: id,
              errorCode: emailSfError?.errorCode,
              errorMessage: emailSfError?.message,
              errorStatusCode: responseEmailSF.status,
              errorStatusText: responseEmailSF.statusText,
              responseData: emailSfError?.raw ?? responseEmailSF.data,
            },
            createdDate: moment.utc().format('YYYY-MM-DD HH:mm:ss'),
          });

          await collection.updateOne({
            id
          }, {
            $set: { processingStatus: FAILED_SYNC_MVR_PDF_SALESFORCE_STATUS },
            $push: {
              auditTrail: {
                action: 'sync-mvr-pdf-salesforce',
                processingStatus: FAILED_SYNC_MVR_PDF_SALESFORCE_STATUS,
                timestamp: moment.utc().format('YYYY-MM-DD HH:mm:ss'),
                user: 'system',
                details: {
                  caseId: caseId,
                  errorCode: emailSfError?.errorCode,
                  errorMessage: emailSfError?.message,
                  errorStatusCode: responseEmailSF.status,
                  errorStatusText: responseEmailSF.statusText,
                  responseData: emailSfError?.raw ?? responseEmailSF.data,
                  message: 'Error sending email for MVR case to Salesforce',
                },
              },
            },
          } as unknown as UpdateFilter<Document>);

          logger.error(`[PRODUCTION] ❌ Error sending email for MVR case: ${caseId}`);
          logger.error({
            status: responseEmailSF.status,
            statusText: responseEmailSF.statusText,
            errorCode: emailSfError?.errorCode,
            errorMessage: emailSfError?.message,
          });

          continue;
        }

        logger.info(`[PRODUCTION] ✅ Email sent successfully for MVR case: ${caseId} with ID: ${responseEmailSF.data.id}`);

        const attachmentPayload = {
          ParentId: responseEmailSF.data.id,
          Name: `${moment.utc().format('YYYYDDMM')}-MVR-${driverFirstName}-${driverLastName}.pdf`,
          Body: base64PDF,
          ContentType: "application/pdf"
        };

        const responseAttachmentSF = await axios.post(
          `${SF_BASE_PATH}/services/data/${SF_API_VERSION}/sobjects/Attachment`,
          attachmentPayload,
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            validateStatus: () => true,
          }
        );

        const attachmentSfError = extractSalesforceError(responseAttachmentSF.data);
        if (responseAttachmentSF.status >= 400 || attachmentSfError) {
          logger.error(`❌ Error sending attachment for MVR case: ${caseId}`);
          logger.error({
            status: responseAttachmentSF.status,
            statusText: responseAttachmentSF.statusText,
            errorCode: attachmentSfError?.errorCode,
            errorMessage: attachmentSfError?.message,
            responseData: responseAttachmentSF.data,
          });

          const syncMvrCasesLogCollection = mongoClient.db().collection(SYNC_MVR_CASES_LOG_COLLECTION);
          await syncMvrCasesLogCollection.insertOne({
            serviceName: RAILWAY_SERVICE_NAME,
            success: false,
            error: 'Error sending attachment for MVR case to Salesforce',
            metadata: {
              caseId: caseId,
              errorCode: attachmentSfError?.errorCode,
              errorMessage: attachmentSfError?.message,
              errorStatusCode: responseAttachmentSF.status,
              errorStatusText: responseAttachmentSF.statusText,
              responseData: attachmentSfError?.raw ?? responseAttachmentSF.data,
              message: 'Error sending attachment for MVR case to Salesforce',
            },
            createdDate: moment.utc().format('YYYY-MM-DD HH:mm:ss'),
          });

          await collection.updateOne({
            id
          }, {
            $set: { processingStatus: FAILED_SYNC_MVR_PDF_SALESFORCE_STATUS },
            $push: {
              auditTrail: {
                action: 'sync-mvr-pdf-salesforce',
                processingStatus: FAILED_SYNC_MVR_PDF_SALESFORCE_STATUS,
                timestamp: moment.utc().format('YYYY-MM-DD HH:mm:ss'),
                user: 'system',
                details: {
                  caseId: caseId,
                  errorCode: attachmentSfError?.errorCode,
                  errorMessage: attachmentSfError?.message,
                  errorStatusCode: responseAttachmentSF.status,
                  errorStatusText: responseAttachmentSF.statusText,
                  responseData: attachmentSfError?.raw ?? responseAttachmentSF.data,
                  message: 'Error sending attachment for MVR case to Salesforce',
                },
              },
            },
          } as unknown as UpdateFilter<Document>);

          logger.error(`[PRODUCTION] ❌ Error sending attachment for MVR case: ${caseId}`);
          logger.error({
            status: responseAttachmentSF.status,
            statusText: responseAttachmentSF.statusText,
            errorCode: attachmentSfError?.errorCode,
            errorMessage: attachmentSfError?.message,
          });

          continue;
        }

        logger.info(`[PRODUCTION] ✅ Attachment sent successfully for MVR case: ${caseId} with ID: ${responseAttachmentSF.data.id}`);

        if (EMAIL_SIMPLE_SENDER_TYPE === 'OrgWideEmailAddress' && !EMAIL_SIMPLE_SENDER_ADDRESS.trim()) {
          logger.error(
            `[PRODUCTION] ❌ EMAIL_SIMPLE_SENDER_ADDRESS is required when EMAIL_SIMPLE_SENDER_TYPE=OrgWideEmailAddress (case ${caseId})`,
          );
          const syncMvrCasesLogCollection = mongoClient.db().collection(SYNC_MVR_CASES_LOG_COLLECTION);
          await syncMvrCasesLogCollection.insertOne({
            serviceName: RAILWAY_SERVICE_NAME,
            success: false,
            error: 'emailSimple config: missing EMAIL_SIMPLE_SENDER_ADDRESS for OrgWideEmailAddress',
            metadata: { caseId: id, salesforceCaseId: caseId },
            createdDate: moment.utc().format('YYYY-MM-DD HH:mm:ss'),
          });
          await collection.updateOne(
            { id },
            {
              $set: { processingStatus: FAILED_SYNC_MVR_PDF_SALESFORCE_STATUS },
              $push: {
                auditTrail: {
                  action: 'sync-mvr-pdf-salesforce',
                  processingStatus: FAILED_SYNC_MVR_PDF_SALESFORCE_STATUS,
                  timestamp: moment.utc().format('YYYY-MM-DD HH:mm:ss'),
                  user: 'system',
                  details: {
                    caseId: caseId,
                    message: 'emailSimple: missing EMAIL_SIMPLE_SENDER_ADDRESS for OrgWideEmailAddress',
                  },
                },
              },
            } as unknown as UpdateFilter<Document>,
          );
          continue;
        }

        const recipientList = [TO_ADDRESS, producerOwnerEmail]
          .filter((e) => e != null && String(e).trim() !== '')
          .join(', ');

        const emailSimplePayload: Record<string, unknown> = {
          emailAddresses: recipientList,
          emailSubject: `MVR PDF Attached - Case: ${caseNumber ?? caseId}`,
          emailBody:
            'You will find the PDF attached.\n\n' +
            (responseEmailSF.data.id
              ? `Related EmailMessage Id (CRM log): ${responseEmailSF.data.id}`
              : ''),
          senderType: EMAIL_SIMPLE_SENDER_TYPE,
        };

        if (EMAIL_SIMPLE_SENDER_TYPE === 'OrgWideEmailAddress') {
          emailSimplePayload.senderAddress = EMAIL_SIMPLE_SENDER_ADDRESS.trim();
        }

        if (responseAttachmentSF.data.id) {
          emailSimplePayload.attachmentId = responseAttachmentSF.data.id;
        }

        if (EMAIL_SIMPLE_LOG_ON_SEND && caseId) {
          emailSimplePayload.relatedRecordId = caseId;
          emailSimplePayload.logEmailOnSend = true;
        }

        const emailSimpleBody = { inputs: [emailSimplePayload] };

        const sendEmailSimpleRes = await axios.post(
          `${SF_BASE_PATH}/services/data/${SF_API_VERSION}/actions/standard/emailSimple`,
          emailSimpleBody,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            validateStatus: () => true,
          },
        );

        const emailSimpleHttpErr = extractSalesforceError(sendEmailSimpleRes.data);
        const emailSimpleInvokeErr = extractEmailSimpleInvokeError(sendEmailSimpleRes.data);
        const emailSimpleFailed =
          sendEmailSimpleRes.status >= 400 || emailSimpleHttpErr || emailSimpleInvokeErr;

        if (emailSimpleFailed) {
          const errDetail =
            emailSimpleInvokeErr ??
            emailSimpleHttpErr ?? {
              message: `HTTP ${sendEmailSimpleRes.status}`,
              raw: sendEmailSimpleRes.data,
            };
          logger.error(`[PRODUCTION] ❌ Error sending emailSimple for MVR case: ${caseId}`);
          logger.error({
            status: sendEmailSimpleRes.status,
            statusText: sendEmailSimpleRes.statusText,
            message: errDetail.message,
            responseData: sendEmailSimpleRes.data,
          });

          const syncMvrCasesLogCollection = mongoClient.db().collection(SYNC_MVR_CASES_LOG_COLLECTION);
          await syncMvrCasesLogCollection.insertOne({
            serviceName: RAILWAY_SERVICE_NAME,
            success: false,
            error: 'Error sending emailSimple for MVR case to Salesforce',
            metadata: {
              caseId: id,
              errorMessage: errDetail.message,
              errorStatusCode: sendEmailSimpleRes.status,
              errorStatusText: sendEmailSimpleRes.statusText,
              responseData: errDetail.raw ?? sendEmailSimpleRes.data,
            },
            createdDate: moment.utc().format('YYYY-MM-DD HH:mm:ss'),
          });

          await collection.updateOne(
            { id },
            {
              $set: { processingStatus: FAILED_SYNC_MVR_PDF_SALESFORCE_STATUS },
              $push: {
                auditTrail: {
                  action: 'sync-mvr-pdf-salesforce',
                  processingStatus: FAILED_SYNC_MVR_PDF_SALESFORCE_STATUS,
                  timestamp: moment.utc().format('YYYY-MM-DD HH:mm:ss'),
                  user: 'system',
                  details: {
                    caseId: caseId,
                    message: 'Error sending emailSimple for MVR case to Salesforce',
                    errorMessage: errDetail.message,
                    errorStatusCode: sendEmailSimpleRes.status,
                    responseData: errDetail.raw ?? sendEmailSimpleRes.data,
                  },
                },
              },
            } as unknown as UpdateFilter<Document>,
          );

          continue;
        }

        logger.info(
          {
            caseId,
            emailSimpleResults: sendEmailSimpleRes.data,
          },
          `[PRODUCTION] ✅ emailSimple completed for MVR case: ${caseId}`,
        );

        const { allReady, notReady, siblings } =
          await allSiblingMvrCasesReadyForSalesforceCaseApproval(
            collection,
            caseId,
            caseNumber
          );

        let caseApprovalPatchedToSalesforce = false;

        if (!allReady) {
          logger.info(
            {
              caseId,
              caseNumber,
              siblingCount: siblings.length,
              notReadyCount: notReady.length,
              notReadyIds: notReady.map((d: any) => d?.id).filter(Boolean),
            },
            "[PRODUCTION] Skipping Case Approval_Status__c — not all drivers for this Case have Verisk PDF + requestIdVerisk yet"
          );
        } else {
          const responseCaseUpdateStatusSF = await axios.patch(
            `${SF_BASE_PATH}/services/data/${SF_API_VERSION}/sobjects/Case/${caseId}`,
            {
              Approval_Status__c: COMPLETED_CASE_APPROVAL_STATUS
            },
            {
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
              },
              validateStatus: () => true,
            }
          );

          const caseUpdateSfError = extractSalesforceError(responseCaseUpdateStatusSF.data);
          if (responseCaseUpdateStatusSF.status >= 400 || caseUpdateSfError) {
            logger.error(`[PRODUCTION] ❌ Error updating case status for MVR case: ${caseId}`);
            logger.error({
              status: responseCaseUpdateStatusSF.status,
              statusText: responseCaseUpdateStatusSF.statusText,
              errorCode: caseUpdateSfError?.errorCode,
              errorMessage: caseUpdateSfError?.message,
              responseData: responseCaseUpdateStatusSF.data,
            });

            const syncMvrCasesLogCollection = mongoClient.db().collection(SYNC_MVR_CASES_LOG_COLLECTION);
            await syncMvrCasesLogCollection.insertOne({
              serviceName: RAILWAY_SERVICE_NAME,
              success: false,
              error: 'Error updating case approval status for MVR case to Salesforce',
              metadata: {
                caseId: caseId,
                errorCode: caseUpdateSfError?.errorCode,
                errorMessage: caseUpdateSfError?.message,
                errorStatusCode: responseCaseUpdateStatusSF.status,
                errorStatusText: responseCaseUpdateStatusSF.statusText,
                responseData: caseUpdateSfError?.raw ?? responseCaseUpdateStatusSF.data,
                message: 'Error updating case approval status for MVR case to Salesforce',
              },
              createdDate: moment.utc().format('YYYY-MM-DD HH:mm:ss'),
            });
            await collection.updateOne({
              id
            }, {
              $set: { processingStatus: FAILED_SYNC_MVR_PDF_SALESFORCE_STATUS },
              $push: {
                auditTrail: {
                  action: 'sync-mvr-pdf-salesforce',
                  processingStatus: FAILED_SYNC_MVR_PDF_SALESFORCE_STATUS,
                  timestamp: moment.utc().format('YYYY-MM-DD HH:mm:ss'),
                  user: 'system',
                  details: {
                    caseId: caseId,
                    errorCode: caseUpdateSfError?.errorCode,
                    errorMessage: caseUpdateSfError?.message,
                    errorStatusCode: responseCaseUpdateStatusSF.status,
                    errorStatusText: responseCaseUpdateStatusSF.statusText,
                    responseData: caseUpdateSfError?.raw ?? responseCaseUpdateStatusSF.data,
                    message: 'Error updating case approval status for MVR case to Salesforce',
                  },
                },
              },
            } as unknown as UpdateFilter<Document>);

            logger.error(`[PRODUCTION] ❌ Error updating case status for MVR case: ${caseId}`);
            logger.error({
              status: responseCaseUpdateStatusSF.status,
              statusText: responseCaseUpdateStatusSF.statusText,
              errorCode: caseUpdateSfError?.errorCode,
              errorMessage: caseUpdateSfError?.message,
            });

            continue;
          }

          logger.info(`[PRODUCTION] ✅ Case status updated successfully for MVR case: ${caseId}`);
          caseApprovalPatchedToSalesforce = true;
        }

        await collection.updateOne({
          id
        }, {
          $set: { caseApprovalStatus: COMPLETED_CASE_APPROVAL_STATUS, processingStatus: UPDATE_PROCESSING_STATUS, emailMessageId: responseEmailSF.data.id, attachmentId: responseAttachmentSF.data.id },
          $push: {
            auditTrail: {
              action: 'sync-mvr-pdf-salesforce',
              processingStatus: UPDATE_PROCESSING_STATUS,
              timestamp: moment.utc().format('YYYY-MM-DD HH:mm:ss'),
              user: 'system',
              details: {
                caseId: id,
                salesforceCaseId: caseId,
                caseNumber: caseNumber ?? null,
                emailMessageId: responseEmailSF.data.id,
                attachmentId: responseAttachmentSF.data.id,
                caseApprovalPatchedToSalesforce,
                ...(!allReady
                  ? {
                      caseApprovalDeferredReason: 'pending_sibling_mvr_drivers',
                      notReadySiblingIds: notReady.map((d: any) => d?.id).filter(Boolean),
                    }
                  : {}),
              },
            },
          },
        } as unknown as UpdateFilter<Document>);
      }

      const syncMvrCasesLogCollection = mongoClient.db().collection(SYNC_MVR_CASES_LOG_COLLECTION);
      await syncMvrCasesLogCollection.insertOne({
        serviceName: RAILWAY_SERVICE_NAME,
        success: true,
        error: null,
        metadata: null,
        createdDate: moment.utc().format('YYYY-MM-DD HH:mm:ss'),
      });

      logger.info(`[PRODUCTION] ✅ Synced ${mvrCases.length} MVR cases successfully`);
      return { success: true, message: "MVR cases synced successfully" };
    } else {
      logger.info("🔍 [DEVELOPMENT] environment detected");

      const emailPayload = {
        ParentId: CASE_ID_TEST,
        Subject: "[DEVELOPMENT] MVR PDF Attached for case: " + CASE_ID_TEST + " from integration",
        TextBody: "[DEVELOPMENT] You will find the PDF attached.",
        Status: EMAIL_STATUS,
        ToAddress: TO_ADDRESS,
        FromAddress: FROM_ADDRESS
      };

      const { data } = await axios.post(
        `${SF_BASE_PATH}/services/data/${SF_API_VERSION}/sobjects/EmailMessage`,
        emailPayload,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          }
        }
      );

      if (data.error) {
        logger.error(`[DEVELOPMENT] ❌ Error sending email for MVR case: ${CASE_ID_TEST}`);
        logger.error(data.error);

        const syncMvrCasesLogCollection = mongoClient.db().collection(SYNC_MVR_CASES_LOG_COLLECTION);
        await syncMvrCasesLogCollection.insertOne({
          serviceName: RAILWAY_SERVICE_NAME,
          success: false,
          error: 'Error sending email for MVR case to Salesforce',
          metadata: {
            environment: 'DEVELOPMENT',
            caseId: CASE_ID_TEST,
            emailId: data.id,
            emailMessageId: data.id,
            attachmentId: data.id,
            emailStatus: EMAIL_STATUS,
            toAddress: TO_ADDRESS,
            subject: "MVR PDF Attached",
            textBody: "You will find the PDF attached.",
          },
          createdDate: moment.utc().format('YYYY-MM-DD HH:mm:ss'),
        });

        await collection.updateOne({
          id: CASE_ID_TEST
        }, {
          $set: { processingStatus: FAILED_SYNC_MVR_PDF_SALESFORCE_STATUS },
          $push: {
            auditTrail: {
              action: 'sync-mvr-pdf-salesforce',
              processingStatus: FAILED_SYNC_MVR_PDF_SALESFORCE_STATUS,
              timestamp: moment.utc().format('YYYY-MM-DD HH:mm:ss'),
              user: 'system',
              details: {
                caseId: CASE_ID_TEST,
                error: data.error,
                errorName: data.error.name,
                errorStack: data.error.stack,
                errorMessage: data.error.message,
                errorStatusCode: data.error.statusCode,
                errorStatusText: data.error.statusText,
                message: 'Error sending email for MVR case to Salesforce',
              },
            },
          },
        } as unknown as UpdateFilter<Document>);

        logger.error(`[DEVELOPMENT] ❌ Error sending email for MVR case: ${CASE_ID_TEST}`);
        logger.error(data.error);
        return;
      }

      logger.info(`[DEVELOPMENT] ✅ Email sent successfully for MVR case: ${CASE_ID_TEST} with ID: ${data.id}`);

      const attachmentPayload = {
        ParentId: data.id,
        Name: `${moment.utc().format('YYYYDDMM')}-MVR-${DRIVER_NAME_TEST}.pdf`,
        Body: BASE64_PDF_TEST,
        ContentType: "application/pdf"
      };

      const { data: attachmentData } = await axios.post(
        `${SF_BASE_PATH}/services/data/${SF_API_VERSION}/sobjects/Attachment`,
        attachmentPayload,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          }
        }
      );

      if (attachmentData.error) {
        logger.error(`[DEVELOPMENT] ❌ Error sending attachment for MVR case: ${CASE_ID_TEST}`);
        logger.error(attachmentData.error);

        const syncMvrCasesLogCollection = mongoClient.db().collection(SYNC_MVR_CASES_LOG_COLLECTION);
        await syncMvrCasesLogCollection.insertOne({
          serviceName: RAILWAY_SERVICE_NAME,
          success: false,
          error: 'Error sending attachment for MVR case to Salesforce',
          metadata: {
            environment: 'DEVELOPMENT',
            caseId: CASE_ID_TEST,
            emailId: data.id,
            emailMessageId: data.id,
            attachmentId: attachmentData.id,
            emailStatus: EMAIL_STATUS,
            toAddress: TO_ADDRESS,
            subject: "MVR PDF Attached",
            textBody: "You will find the PDF attached.",
            base64PDF: BASE64_PDF_TEST,
          },
          createdDate: moment.utc().format('YYYY-MM-DD HH:mm:ss'),
        });

        await collection.updateOne({
          id: CASE_ID_TEST
        }, {
          $set: { processingStatus: FAILED_SYNC_MVR_PDF_SALESFORCE_STATUS },
          $push: {
            auditTrail: {
              action: 'sync-mvr-pdf-salesforce',
              processingStatus: FAILED_SYNC_MVR_PDF_SALESFORCE_STATUS,
              timestamp: moment.utc().format('YYYY-MM-DD HH:mm:ss'),
              user: 'system',
              details: {
                caseId: CASE_ID_TEST,
                error: attachmentData.error,
                errorName: attachmentData.error.name,
                errorStack: attachmentData.error.stack,
                errorMessage: attachmentData.error.message,
                errorStatusCode: attachmentData.error.statusCode,
                errorStatusText: attachmentData.error.statusText,
                message: 'Error sending attachment for MVR case to Salesforce',
              },
            },
          },
        } as unknown as UpdateFilter<Document>);

        logger.error(`[DEVELOPMENT] ❌ Error sending attachment for MVR case: ${CASE_ID_TEST}`);
        logger.error(attachmentData.error);
        return;
      }

      const { data: caseUpdateStatus } = await axios.patch(
        `${SF_BASE_PATH}/services/data/${SF_API_VERSION}/sobjects/Case__c/${CASE_ID_TEST}`,
        {
          Approval_Status__c: COMPLETED_CASE_APPROVAL_STATUS
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          }
        }
      );

      if (caseUpdateStatus.error) {
        logger.error(`[DEVELOPMENT] ❌ Error updating case status for MVR case: ${CASE_ID_TEST}`);
        logger.error(caseUpdateStatus.error);

        const syncMvrCasesLogCollection = mongoClient.db().collection(SYNC_MVR_CASES_LOG_COLLECTION);
        await syncMvrCasesLogCollection.insertOne({
          serviceName: RAILWAY_SERVICE_NAME,
          success: false,
          error: 'Error updating case status for MVR case to Salesforce',
          metadata: {
            caseId: CASE_ID_TEST,
            error: caseUpdateStatus.error,
            errorName: caseUpdateStatus.error.name,
            errorStack: caseUpdateStatus.error.stack,
            errorMessage: caseUpdateStatus.error.message,
            errorStatusCode: caseUpdateStatus.error.statusCode,
            errorStatusText: caseUpdateStatus.error.statusText,
          },
          createdDate: moment.utc().format('YYYY-MM-DD HH:mm:ss'),
        });

        await collection.updateOne({
          id: CASE_ID_TEST
        }, {
          $set: { processingStatus: FAILED_SYNC_MVR_PDF_SALESFORCE_STATUS },
          $push: {
            auditTrail: {
              action: 'sync-mvr-pdf-salesforce',
              processingStatus: FAILED_SYNC_MVR_PDF_SALESFORCE_STATUS,
              timestamp: moment.utc().format('YYYY-MM-DD HH:mm:ss'),
              user: 'system',
              details: {
                caseId: CASE_ID_TEST,
                error: caseUpdateStatus.error,
                errorName: caseUpdateStatus.error.name,
                errorStack: caseUpdateStatus.error.stack,
                errorMessage: caseUpdateStatus.error.message,
                errorStatusCode: caseUpdateStatus.error.statusCode,
                errorStatusText: caseUpdateStatus.error.statusText,
                message: 'Error updating case status for MVR case to Salesforce',
              },
            },
          },
        } as unknown as UpdateFilter<Document>);

        logger.error(`[DEVELOPMENT] ❌ Error updating case status for MVR case: ${CASE_ID_TEST}`);
        logger.error(caseUpdateStatus.error);
        return;
      }

      const syncMvrCasesLogCollection = mongoClient.db().collection(SYNC_MVR_CASES_LOG_COLLECTION);
      await syncMvrCasesLogCollection.insertOne({
        serviceName: RAILWAY_SERVICE_NAME,
        success: true,
        error: null,
        metadata: {
          environment: 'DEVELOPMENT',
          caseId: CASE_ID_TEST,
          emailId: data.id,
          emailMessageId: data.id,
          attachmentId: attachmentData.id,
          emailStatus: EMAIL_STATUS,
          toAddress: TO_ADDRESS,
          subject: "MVR PDF Attached",
          textBody: "You will find the PDF attached.",
          base64PDF: BASE64_PDF_TEST,
        },
        createdDate: moment.utc().format('YYYY-MM-DD HH:mm:ss'),
      });

      await collection.updateOne({
        id: CASE_ID_TEST
      }, {
        $set: { processingStatus: UPDATE_PROCESSING_STATUS },
        $push: {
          auditTrail: {
            action: 'sync-mvr-pdf-salesforce',
            processingStatus: UPDATE_PROCESSING_STATUS,
            timestamp: moment.utc().format('YYYY-MM-DD HH:mm:ss'),
            user: 'system',
            details: {
              caseId: CASE_ID_TEST,
              emailMessageId: data.id,
              attachmentId: attachmentData.id,
            },
          },
        },
      } as unknown as UpdateFilter<Document>);

      logger.info(`[DEVELOPMENT] ✅ Synced MVR case: ${CASE_ID_TEST} successfully`);
    }
  } catch (error: unknown) {
    if (mongoClient) {
      const syncMvrCasesLogCollection = mongoClient.db().collection(SYNC_MVR_CASES_LOG_COLLECTION);
      const errMessage = error instanceof Error ? error.message : String(error);
      await syncMvrCasesLogCollection.insertOne({
        serviceName: RAILWAY_SERVICE_NAME,
        success: false,
        error: errMessage || 'unknown error',
        metadata: toMongoSafeErrorMetadata(error),
        createdDate: moment.utc().format('YYYY-MM-DD HH:mm:ss'),
      });
    }

    logger.error('error:', error);
  } finally {
    // Redis must be closed or the TCP connection keeps the event loop alive and
    // serverless/railway runs hang after the handler "returns" (return does not close sockets).
    try {
      if (redisClient.isOpen) {
        await redisClient.quit();
      }
    } catch (err: any) {
      logger.warn({ err: err?.message }, "redis quit during shutdown");
    }
    try {
      await mongoClient.close();
    } catch (err: any) {
      logger.warn({ err: err?.message }, "mongo close during shutdown");
    }
    logger.info("connections closed (redis + mongo)");
  }
})();
