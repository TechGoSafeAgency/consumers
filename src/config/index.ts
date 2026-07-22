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
};