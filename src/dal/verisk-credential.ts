import { Collections, VeriskCredentialStatus } from "@/types";
import { IVeriskCredential, IVeriskCredentialDAL } from "@/types/interfaces/dal/IVeriskCredentialDAL";
import { Db } from "mongodb";

export const veriskCredentialDALFactory = (mongoDB: Db): IVeriskCredentialDAL => ({
  getActiveVeriskCredentials: async () => {
    const credential = await mongoDB.collection<IVeriskCredential>(Collections.VERISK_CREDENTIALS).findOne(
      { status: VeriskCredentialStatus.ACTIVE },
      { projection: { _id: 0} }
    );
    
    return credential || null;
  },
});