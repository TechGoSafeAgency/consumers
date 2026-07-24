import { ObjectId } from "mongodb";

export type ISyncMVRCaseLog = {
  serviceName: string;
  success: boolean;
  error: string | null;
  metadata: Record<string, any> | null;
  createdDate: string;
};

export interface ISyncMVRCaseLogDAL {
  createSyncMVRCaseLog: (log: ISyncMVRCaseLog) => Promise<void>;
}
