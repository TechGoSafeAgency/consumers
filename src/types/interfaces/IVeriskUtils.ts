import { IVeriskCredential } from "./dal/IVeriskCredentialDAL";

export interface IVeriskUtils {
  pad: (value: string, length: number) => string;
  normalizeDobForVerisk: (dob: unknown) => string;
  extractResponseString: (result: any) => string;
  buildMvrRequest: (drive: any, credentials: { user: string, password: string, account: string }) => string;
  buildPdfPollString: (requestId: string, credentials: IVeriskCredential) => string;
};