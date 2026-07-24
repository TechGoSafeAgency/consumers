import 'dotenv/config';

export const config = {
  mongoDBUri: process.env.MONGO_DB_URI ?? '',
  rabbitmqUri: process.env.RABBITMQ_URI ?? '',
  soapForceIpv4: process.env.SOAP_FORCE_IPV4 === 'true',
  soapHttpTimeoutMs: Number(process.env.SOAP_HTTP_TIMEOUT_MS ?? 120000),
  wsdlPrefetch: process.env.WSDL_PREFETCH === 'true',
  wsdlUrl: process.env.WSDL_URL ?? '',
  wsdlDisableCache: process.env.WSDL_DISABLE_CACHE === 'true',
  wsdlLocalPath: process.env.WSDL_LOCAL_PATH || undefined,
  // # NEW ENV VARIABLES
  salesforceBaseUrl: process.env.SALESFORCE_BASE_URL ?? 'https://gosafe.my.salesforce.com',
  redisUri: process.env.REDIS_URI ?? '',
  emailNotificationsTo: process.env.EMAIL_NOTIFICATIONS_TO ?? 'finances@gosafeagency.com',

  authAppKey: process.env.AUTH_APP_KEY ?? '',
  appAuthId: process.env.APP_AUTH_ID ?? '',
  appAuthSecret: process.env.APP_AUTH_SECRET ?? '',
  application: process.env.APPLICATION ?? 'SERVERLESS-SYNC-MVR-CASES',
  authApiUrl: process.env.AUTH_API_URL ?? '',  
  emailStatus: process.env.EMAIL_STATUS ?? '3',
  completedCaseApprovalStatus: process.env.COMPLETED_CASE_APPROVAL_STATUS ?? 'Completed',
  emailSimpleSenderType: process.env.EMAIL_SIMPLE_SENDER_TYPE ?? 'CurrentUser',
  emailSimpleSenderAddress: process.env.EMAIL_SIMPLE_SENDER_ADDRESS ?? '',
  sfApiVersion: process.env.SF_API_VERSION ?? 'v53.0',
  emailSimpleLogOnSend: process.env.EMAIL_SIMPLE_LOG_ON_SEND !== 'false' && process.env.EMAIL_SIMPLE_LOG_ON_SEND !== '0',
};