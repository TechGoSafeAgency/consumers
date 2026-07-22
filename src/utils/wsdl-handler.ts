import axios from 'axios';
import dns from 'node:dns';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { Logger } from 'winston';
import { IWsdlHandler } from '@/types';

const MAX_REDIRECTS = 10;
const MAX_ERROR_BODY_CHARS = 500;

const createSoapHttpAxios = ({
  soapForceIpv4,
  soapHttpTimeoutMs,
  wsdlBrowserHeaders,
}: {
  soapForceIpv4: boolean;
  soapHttpTimeoutMs: number;
  wsdlBrowserHeaders: Record<string, string>;
}) => {
  const lookup = soapForceIpv4
    ? (hostname: string, _opts: object, cb: (err: Error | null, address: string, family: number) => void) => {
        dns.lookup(hostname, { family: 4 }, cb);
      }
    : undefined;

  const httpsAgent = new https.Agent({ keepAlive: true, ...(lookup && { lookup }) });
  const httpAgent = new http.Agent({ keepAlive: true, ...(lookup && { lookup }) });

  return axios.create({
    httpsAgent,
    httpAgent,
    timeout: Number(soapHttpTimeoutMs ?? 120_000),
    maxRedirects: MAX_REDIRECTS,
    validateStatus: () => true,
    headers: { ...wsdlBrowserHeaders },
    responseType: 'text',
  });
};

export const wsdlHandlerFactory = ({
  soapForceIpv4,
  soapHttpTimeoutMs,
  wsdlBrowserHeaders,
  wsdlLocalPath,
  wsdlPrefetch,
  wsdlUrl,
  wsdlDisableCache,
  logger,
}: {
  soapForceIpv4: boolean;
  soapHttpTimeoutMs: number;
  wsdlBrowserHeaders: Record<string, string>;
  wsdlLocalPath: string | undefined;
  wsdlPrefetch: boolean;
  wsdlUrl: string;
  wsdlDisableCache: boolean;
  logger: Logger;
}): IWsdlHandler => {
  const httpClient = createSoapHttpAxios({
    soapForceIpv4,
    soapHttpTimeoutMs,
    wsdlBrowserHeaders,
  });

  return {
    resolveWsdlLocationForSoap: async () => {
      if (wsdlLocalPath) {
        const resolved = path.resolve(wsdlLocalPath);

        if (!fs.existsSync(resolved)) {
          throw new Error(`WSDL_LOCAL_PATH does not exist: ${resolved}`);
        }

        logger.info(`Using local WSDL bundle (WSDL_LOCAL_PATH): ${resolved}`);
        return resolved;
      }

      if (wsdlPrefetch) {
        logger.info(
          `Prefetching WSDL via axios (SOAP_FORCE_IPV4=${soapForceIpv4}). Prefer WSDL_LOCAL_PATH if schema imports fail. ${wsdlUrl}`,
        );

        try {
          const hostname = new URL(wsdlUrl).hostname;
          const address = soapForceIpv4
            ? await dns.promises.lookup(hostname, { family: 4 })
            : await dns.promises.lookup(hostname);
          logger.info('Resolved WSDL host for prefetch', {
            hostname,
            address: address.address,
            family: address.family,
            soapForceIpv4,
          });
        } catch (error) {
          logger.warn('Could not resolve WSDL host before prefetch', { error });
        }

        const res = await httpClient.get<string>(wsdlUrl);

        if (res.status < 200 || res.status >= 300) {
          const body =
            typeof res.data === 'string'
              ? res.data.slice(0, MAX_ERROR_BODY_CHARS)
              : JSON.stringify(res.data).slice(0, MAX_ERROR_BODY_CHARS);
          throw new Error(
            `WSDL prefetch failed: HTTP ${res.status} ${res.statusText ?? ''}`.trim() +
              (body ? ` — body: ${body}` : ''),
          );
        }

        const tmp = path.join(os.tmpdir(), `verisk-wsdl-${Date.now()}.wsdl`);
        fs.writeFileSync(tmp, res.data, 'utf8');
        logger.info(`Wrote prefetched WSDL to temp; relative imports resolve next to this path: ${tmp}`);
        return tmp;
      }

      logger.info(`Using WSDL URL (WSDL_URL): ${wsdlUrl}`);
      return wsdlUrl;
    },
    buildSoapClientOptions: () => {
      const base = (() => {
        try {
          return new URL(wsdlUrl);
        } catch {
          return null;
        }
      })();

      return {
        disableCache: wsdlDisableCache,
        endpoint: wsdlUrl.replace(/\?WSDL.*$/i, ''),
        request: httpClient,
        wsdl_headers: { ...wsdlBrowserHeaders },
        wsdl_options: {
          overrideImportLocation: (includePath: string, _parentUri?: string, _rawLocation?: string) => {
            try {
              const u = new URL(includePath);
              if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
                if (!base) return includePath;
                const rewritten = new URL(u.pathname + u.search, `${base.protocol}//${base.host}`).href;
                logger.warn(`Rewrote loopback WSDL import to WSDL host: ${includePath} -> ${rewritten}`);
                return rewritten;
              }
            } catch {
              /* keep includePath */
            }
            return includePath;
          },
        },
      };
    },
  };
};
