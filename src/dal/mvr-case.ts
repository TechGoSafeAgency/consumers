import { Db } from "mongodb";
import { Collections, IMVRCase, IMVRCaseDAL } from "@/types";

export const mvrCaseDALFactory = (mongoDB: Db): IMVRCaseDAL => ({
  getMVRCases: async () => {
    const collection = mongoDB.collection<IMVRCase>(Collections.MVR_CASES);
    const cases = await collection.find({}).toArray();
    return cases;
  },
  getMVRCaseById: async (id: string) => {
    const mvrCase = await mongoDB.collection<IMVRCase>(Collections.MVR_CASES).findOne({ id });
    return mvrCase || null;
  },
  updateMVRCaseStatus: async (id: string, status: string) => {
    await mongoDB.collection<IMVRCase>(Collections.MVR_CASES).updateOne({ id }, { $set: { processingStatus: status } });
  },
  updateMVRCaseBase64PDF: async (id: string, base64PDF: string) => {
    await mongoDB.collection<IMVRCase>(Collections.MVR_CASES).updateOne({ id }, { $set: { base64PDF } });
  },
  updateMVRCaseRequestIdVerisk: async (id: string, requestId: string) => {
    await mongoDB.collection<IMVRCase>(Collections.MVR_CASES).updateOne({ id }, { $set: { requestIdVerisk: requestId } });
  },
  updateMVRCaseRequestStrVerisk: async (id: string, requestStr: string) => {
    await mongoDB.collection<IMVRCase>(Collections.MVR_CASES).updateOne({ id }, { $set: { requestStrVerisk: requestStr } });
  },
});
