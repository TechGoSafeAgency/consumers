import 'dotenv/config';
import { MongoClient } from 'mongodb';

/**
MONGO_DB_URI="mongodb+srv://support:qaYKG7nxUykRd8EP@gosafeagency.qgiayte.mongodb.net/intranet-production"
RABBITMQ_URI="amqp://Ak0JvF62j0TfDVFB:wsdG~ra-QTcxCq~zg0ynmbXGrR_QwNbo@rabbitmq.railway.internal:5672"
SOAP_FORCE_IPV4=true
SOAP_HTTP_TIMEOUT_MS=120000
WSDL_PREFETCH=true
WSDL_URL="https://expressnet.iix.com/web-services/Auth?WSDL"
WSDL_DISABLE_CACHE=true
 */

export const config = {
  mongoDBUri: process.env.MONGO_DB_URI ?? '',
  rabbitmqUri: process.env.RABBITMQ_URI ?? '',
  soapForceIpv4: process.env.SOAP_FORCE_IPV4 === 'true',
  soapHttpTimeoutMs: Number(process.env.SOAP_HTTP_TIMEOUT_MS ?? 120000),
  wsdlPrefetch: process.env.WSDL_PREFETCH === 'true',
  wsdlUrl: process.env.WSDL_URL ?? '',
  wsdlDisableCache: process.env.WSDL_DISABLE_CACHE === 'true',
};