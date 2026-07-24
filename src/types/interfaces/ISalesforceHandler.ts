export type ISalesforceError = {
  message: string;
  errorCode?: string;
  raw: unknown;
};

export type ISalesforceResponse = {
  id: string;
}

export interface ISalesforceEmailPayload {
  ParentId: string;
  Subject: string;
  TextBody: string;
  Status: string;
  ToAddress: string;
  FromAddress: string;
}

export interface ISalesforceEmailAttachmentPayload {
  ParentId: string;
  Name: string;
  Body: string;
  ContentType: string;
}

export interface ISalesforceEmailSimplePayload {
  relatedRecordId?: string;
  logEmailOnSend?: boolean;
  attachmentId?: string;
  senderAddress?: string;
  emailAddresses: string;
  emailSubject: string;
  emailBody: string;
  senderType: string;
}

export interface ISalesforceCasePayload {
  Approval_Status__c: string;
}

export interface ISalesforceHandler {
  postSalesforceEmailMessage: (params: {
    salesforceAuthToken: string;
    emailPayload: ISalesforceEmailPayload;
  }) => Promise<ISalesforceError | ISalesforceResponse>;
  postSalesforceEmailAttachment: (params: {
    salesforceAuthToken: string;
    attachmentPayload: ISalesforceEmailAttachmentPayload;
  }) => Promise<ISalesforceError | ISalesforceResponse>;
  postSalesforceEmailSimple: (params: {
    salesforceAuthToken: string;
    emailSimplePayload: ISalesforceEmailSimplePayload;
  }) => Promise<ISalesforceError | ISalesforceResponse>;
  patchSalesforceCaseApprovalStatus: (params: {
    salesforceAuthToken: string;
    caseId: string;
    casePayload: ISalesforceCasePayload;
  }) => Promise<ISalesforceError | ISalesforceResponse>;
};
