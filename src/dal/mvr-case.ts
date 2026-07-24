import { Db } from 'mongodb';
import { Collections, IMVRCase, IMVRCaseAuditTrailEntry, IMVRCaseDAL } from '@/types';
import moment from 'moment';

export const mvrCaseDALFactory = (mongoDB: Db): IMVRCaseDAL => ({
  getMVRCases: async () => {
    const collection = mongoDB.collection<IMVRCase>(Collections.MVR_CASES_BACKUP_1);
    const cases = await collection.find({}).toArray();
    return cases;
  },
  getMVRCaseById: async (id: string) => {
    const mvrCase = await mongoDB.collection<IMVRCase>(Collections.MVR_CASES_BACKUP_1).findOne({ id });
    return mvrCase || null;
  },
  updateMVRCaseStatus: async (id: string, status: string) => {
    await mongoDB.collection<IMVRCase>(Collections.MVR_CASES_BACKUP_1).updateOne({ id }, { $set: { processingStatus: status } });
  },
  updateMVRCaseBase64PDF: async (id: string, base64PDF: string) => {
    await mongoDB.collection<IMVRCase>(Collections.MVR_CASES_BACKUP_1).updateOne({ id }, { $set: { base64PDF } });
  },
  updateMVRCaseRequestIdVerisk: async (id: string, requestId: string) => {
    await mongoDB.collection<IMVRCase>(Collections.MVR_CASES_BACKUP_1).updateOne({ id }, { $set: { requestIdVerisk: requestId } });
  },
  updateMVRCaseRequestStrVerisk: async (id: string, requestStr: string) => {
    await mongoDB.collection<IMVRCase>(Collections.MVR_CASES_BACKUP_1).updateOne({ id }, { $set: { requestStrVerisk: requestStr } });
  },
  pushAuditTrail: async (id: string, auditTrail: IMVRCaseAuditTrailEntry) => {
    await mongoDB.collection<IMVRCase>(Collections.MVR_CASES_BACKUP_1).updateOne({ id }, { $push: { auditTrail } });
  },
  getSiblingMvrCases: async (caseId, caseNumber) => {
    const filter: Record<string, string> = { caseId };
    if (caseNumber != null && String(caseNumber).trim() !== '') {
      filter.caseNumber = String(caseNumber);
    }
    return mongoDB.collection<IMVRCase>(Collections.MVR_CASES_BACKUP_1).find(filter).toArray();
  },
  updateMVRCaseApprovalStatus: async (params) => {
    await mongoDB.collection<IMVRCase>(Collections.MVR_CASES_BACKUP_1).updateOne(
      { id: params.id },
      {
        $set: {
          caseApprovalStatus: params.caseApprovalStatus,
          processingStatus: params.processingStatus,
          emailMessageId: params.emailMessageId,
          attachmentId: params.attachmentId,
        },
        $push: {
          auditTrail: {
            action: 'sync-mvr-pdf-salesforce',
            processingStatus: params.processingStatus,
            timestamp: moment.utc().format('YYYY-MM-DD HH:mm:ss'),
            user: 'system',
            details: {
              caseId: params.id,
              caseNumber: params.caseNumber ?? undefined,
              emailMessageId: params.emailMessageId,
              attachmentId: params.attachmentId,
              caseApprovalPatchedToSalesforce: params.caseApprovalPatchedToSalesforce,
              ...(params.caseApprovalDeferredReason
                ? {
                    caseApprovalDeferredReason: params.caseApprovalDeferredReason,
                    notReadySiblingIds: params.notReadySiblingIds ?? [],
                  }
                : {}),
            },
          },
        },
      },
    );
  },
});
