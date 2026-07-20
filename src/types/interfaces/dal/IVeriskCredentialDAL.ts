import { ObjectId } from "mongodb";
import { VeriskCredentialStatus } from "@/types/enums/verisk-credential-status";

export interface IVeriskCredential {
  _id: ObjectId;
  account: string;
  user: string;
  password: string;
  status: VeriskCredentialStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface IVeriskCredentialDAL {
  getActiveVeriskCredentials: () => Promise<IVeriskCredential | null>;
}