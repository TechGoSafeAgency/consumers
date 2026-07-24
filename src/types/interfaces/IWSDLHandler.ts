export interface IWsdlHandler {
  resolveWsdlLocationForSoap: () => Promise<string>;
  buildSoapClientOptions: () => Record<string, any>;
};
