import axios from 'axios';
import dns from 'node:dns';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { Logger } from 'winston';
import { IWsdlHandler } from "@/types";

const MAX_REDIRECTS = 10;

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
  });
}

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
}): IWsdlHandler => ({
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
      logger.info(`Prefetching WSDL with fetch() then loading from temp file (WSDL_PREFETCH). If the WSDL uses relative schema imports, vendor all files to one folder and use WSDL_LOCAL_PATH instead. ${wsdlUrl}`);

      const res = await fetch(wsdlUrl, { headers: { ...wsdlBrowserHeaders } });

      if (!res.ok) {
        throw new Error(`WSDL prefetch failed: HTTP ${res.status} ${res.statusText}`);
      }

      const tmp = path.join(os.tmpdir(), `verisk-wsdl-${Date.now()}.wsdl`);
      fs.writeFileSync(tmp, await res.text(), 'utf8');
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
      request: createSoapHttpAxios({
        soapForceIpv4,
        soapHttpTimeoutMs,
        wsdlBrowserHeaders,
      }),
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
    }
  }
});