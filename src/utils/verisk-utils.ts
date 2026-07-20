import { IVeriskUtils } from '@/types';

const pad = (value: string, length: number) => {
  const str = value ? String(value) : "";
  if (str.length > length) return str.substring(0, length);
  return str.padEnd(length, " ");
}

export const veriskUtilsFactory = (): IVeriskUtils => ({
  pad,
  normalizeDobForVerisk: (dob) => {
    if (typeof dob === 'string' && /^\d{8}$/.test(dob)) return dob;
    if (dob && typeof dob === 'object' && 'day' in dob && 'month' in dob && 'year' in dob) {
      const d = dob as { day: string; month: string; year: string };
      const month = String(d.month).padStart(2, '0');
      const day = String(d.day).padStart(2, '0');
      const year = String(d.year);
      return `${month}${day}${year}`;
    }
    return '';
  },
  extractResponseString: (result) => {
    if (result == null) return "";
    if (typeof result === "string") return result.trim();
    if (result.return) {
      if (result.return.$value) return String(result.return.$value).trim();
      if (typeof result.return === "string") return result.return.trim();
    }
    if (result.$value) return String(result.$value).trim();
    return JSON.stringify(result);
  },
  buildMvrRequest: (driver, credentials) => {
    let req = "";
    req +=
      pad("00", 2) +
      pad(credentials.user, 3) +
      pad(credentials.password, 20) +
      pad(credentials.account, 6) +
      pad("000", 3) +
      pad("MVR", 3);
    
    req +=
        pad("I", 1) + pad(driver.state, 2) + pad("000", 3) + pad("000000", 6);
    
    const dlClean = (driver.dl || "")
        .replace(/[^a-zA-Z0-9]/g, "")
        .toUpperCase();
    
    req += pad(dlClean, 19);
    
    req +=
      pad(driver.lastName, 20) +
      pad("", 3) +
      pad(driver.firstName, 15) +
      pad("", 15);
    
    req +=
      pad(driver.dob, 8) +
      pad("", 1) +
      pad("", 8) +
      pad(`${process.env.NODE_ENV === 'production' ? '' : 'GO SAFE AGENCY'}`, 40);
      
    req += pad("", 1) + "V20" + " " + pad("", 9) + pad("", 30);
    
    return req;
  },
  buildPdfPollString: (requestId, credentials) => {
    const authPrefix =
      pad('00', 2) +
      pad(credentials.user, 3) +
      pad(credentials.password, 20) +
      pad(credentials.account, 6) +
      pad('000', 3) +
      pad('MVR', 3);

    return authPrefix + pad(requestId, 9);
  }
});
