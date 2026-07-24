import { Db } from 'mongodb';
import { Collections, ISyncMVRCaseLogDAL } from '@/types';

export const syncMVRCaseLogDALFactory = (mongoDB: Db): ISyncMVRCaseLogDAL => ({
  createSyncMVRCaseLog: async (log) => {
    await mongoDB.collection(Collections.SYNC_MVR_CASE_LOG).insertOne(log);
  },
});
