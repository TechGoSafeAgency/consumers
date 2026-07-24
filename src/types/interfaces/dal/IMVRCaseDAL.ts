import type { ObjectId } from 'mongodb';

export interface IMVRCaseDateParts {
  day: string;
  month: string;
  year: string;
}

export interface IMVRCaseAuditTrailDetails {
  caseId?: string;
  caseName?: string;
  caseNumber?: string;
  salesforceCaseId?: string;
  emailMessageId?: string;
  attachmentId?: string;
  caseApprovalPatchedToSalesforce?: boolean;
  caseApprovalDeferredReason?: string;
  notReadySiblingIds?: string[];
  errorCode?: string;
  errorMessage?: string;
  responseData?: unknown;
  message?: string;
}

export interface IMVRCaseAuditTrailEntry {
  action: string;
  processingStatus: string;
  timestamp: string;
  user: string;
  details: IMVRCaseAuditTrailDetails;
}

export interface IMVRCase {
  _id: ObjectId;
  id: string;
  caseName: string;
  caseNumber: string;
  caseId: string;
  caseRecordTypeDevName: string;
  caseStatus: string;
  caseApprovalStatus: string;
  driverId: string;
  driverFullName: string;
  driverFirstName: string;
  driverMiddleName: string | null;
  driverLastName: string;
  driverLicenseNumber: string;
  driverLicenseClass: string;
  caseConfirmedPayment: boolean;
  caseMVRPaymentStatus: string;
  producerOwnerId: string;
  producerOwnerEmail: string;
  producerOwnerFirstName: string;
  producerOwnerLastName: string;
  driverLicenseState: string;
  driverYearsOfExperience: number;
  driverDateOfBirth: IMVRCaseDateParts;
  driverDateOfHired: IMVRCaseDateParts;
  driverAction: string;
  createdDate: Date;
  lastModifiedDate: Date;
  processingStatus: string;
  auditTrail: IMVRCaseAuditTrailEntry[];
  base64PDF?: string;
  requestIdVerisk?: string;
  requestStrVerisk?: string;
  attachmentId?: string;
  emailMessageId?: string;
}

export interface IMVRCaseDAL {
  getMVRCases: () => Promise<IMVRCase[]>;
  getMVRCaseById: (id: string) => Promise<IMVRCase | null>;
  updateMVRCaseStatus: (id: string, status: string) => Promise<void>;
  updateMVRCaseBase64PDF: (id: string, base64PDF: string) => Promise<void>;
  updateMVRCaseRequestIdVerisk: (id: string, requestId: string) => Promise<void>;
  updateMVRCaseRequestStrVerisk: (id: string, requestStr: string) => Promise<void>;
  pushAuditTrail: (id: string, auditTrail: IMVRCaseAuditTrailEntry) => Promise<void>;
  getSiblingMvrCases: (caseId: string, caseNumber?: string | null) => Promise<IMVRCase[]>;
  updateMVRCaseApprovalStatus: (params: {
    id: string;
    caseApprovalStatus: string;
    processingStatus: string;
    emailMessageId: string;
    attachmentId: string;
    caseApprovalPatchedToSalesforce: boolean;
    caseNumber?: string | null;
    caseApprovalDeferredReason?: string;
    notReadySiblingIds?: string[];
  }) => Promise<void>;
}
