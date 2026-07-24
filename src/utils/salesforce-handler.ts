import { AxiosInstance } from 'axios';
import { ISalesforceError, ISalesforceHandler } from '@/types/interfaces/ISalesforceHandler';
import { logger } from '@/utils/logger';

function extractSalesforceError(data: unknown): ISalesforceError | null {
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0] as { message?: string; errorCode?: string };

    if (first?.message || first?.errorCode) {
      return { message: first.message ?? 'Unknown Salesforce error', errorCode: first.errorCode, raw: data };
    }
  }

  if (data && typeof data === 'object') {
    const obj = data as { message?: string; error?: unknown };
    if (typeof obj.message === 'string') {
      return { message: obj.message, raw: data };
    }
    if (obj.error) {
      return { message: 'Salesforce returned an error object', raw: obj.error };
    }
  }

  return null;
}

/**
 * Invocable POST often returns HTTP 200 with body `{ results: [{ isSuccess, errors }] }`.
 * Treat isSuccess === false as failure even when status is 200.
 */
function extractEmailSimpleInvokeError(data: unknown): ISalesforceError | null {
  if (!data || typeof data !== 'object') return null;
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results) || results.length === 0) return null;
  const first = results[0] as { isSuccess?: boolean; errors?: unknown };
  if (first.isSuccess !== false) return null;
  const errs = first.errors;
  if (Array.isArray(errs) && errs.length > 0) {
    const e0 = errs[0] as { message?: string; statusCode?: string };
    return {
      message: e0.message ?? 'emailSimple returned isSuccess false',
      errorCode: e0.statusCode,
      raw: data,
    };
  }
  return { message: 'emailSimple returned isSuccess false', raw: data };
}

const sfRequestHeaders = (salesforceAuthToken: string) => ({
  Authorization: `Bearer ${salesforceAuthToken}`,
  'Content-Type': 'application/json',
});

export const salesforceHandlerFactory = ({
  axiosInstance,
  salesforceApiVersion,
}: {
  axiosInstance: AxiosInstance;
  salesforceApiVersion: string;
}): ISalesforceHandler => ({
  postSalesforceEmailMessage: async (params) => {
    try {
      const { salesforceAuthToken, emailPayload } = params;

      const response = await axiosInstance.post(
        `/services/data/${salesforceApiVersion}/sobjects/EmailMessage`,
        emailPayload,
        {
          headers: sfRequestHeaders(salesforceAuthToken),
          validateStatus: () => true,
        },
      );

      const salesforceError = extractSalesforceError(response.data);
      if (response.status >= 400 || salesforceError) {
        return (
          salesforceError ?? {
            message: `HTTP ${response.status} ${response.statusText}`,
            raw: response.data,
          }
        );
      }

      return { id: response.data.id };
    } catch (error: any) {
      logger.error('Failed to post Salesforce email message', { error });
      throw new Error(`posting error: ${error.message}`);
    }
  },
  postSalesforceEmailAttachment: async (params) => {
    try {
      const { salesforceAuthToken, attachmentPayload } = params;

      const response = await axiosInstance.post(
        `/services/data/${salesforceApiVersion}/sobjects/Attachment`,
        attachmentPayload,
        {
          headers: sfRequestHeaders(salesforceAuthToken),
          validateStatus: () => true,
        },
      );

      const salesforceError = extractSalesforceError(response.data);
      if (response.status >= 400 || salesforceError) {
        return (
          salesforceError ?? {
            message: `HTTP ${response.status} ${response.statusText}`,
            raw: response.data,
          }
        );
      }

      return { id: response.data.id };
    } catch (error: any) {
      logger.error('Failed to post Salesforce email attachment', { error });
      throw new Error(`posting error: ${error.message}`);
    }
  },
  postSalesforceEmailSimple: async (params) => {
    try {
      const { salesforceAuthToken, emailSimplePayload } = params;

      const response = await axiosInstance.post(
        `/services/data/${salesforceApiVersion}/actions/standard/emailSimple`,
        { inputs: [emailSimplePayload] },
        {
          headers: sfRequestHeaders(salesforceAuthToken),
          validateStatus: () => true,
        },
      );

      const salesforceError =
        extractEmailSimpleInvokeError(response.data) ?? extractSalesforceError(response.data);

      if (response.status >= 400 || salesforceError) {
        return (
          salesforceError ?? {
            message: `HTTP ${response.status} ${response.statusText}`,
            raw: response.data,
          }
        );
      }

      const resultId =
        response.data?.id ??
        response.data?.results?.[0]?.id ??
        emailSimplePayload.relatedRecordId ??
        'emailSimple-ok';

      return { id: String(resultId) };
    } catch (error: any) {
      logger.error('Failed to post Salesforce email simple', { error });
      throw new Error(`posting error: ${error.message}`);
    }
  },
  patchSalesforceCaseApprovalStatus: async (params) => {
    try {
      const { salesforceAuthToken, caseId, casePayload } = params;

      const response = await axiosInstance.patch(
        `/services/data/${salesforceApiVersion}/sobjects/Case/${caseId}`,
        casePayload,
        {
          headers: sfRequestHeaders(salesforceAuthToken),
          validateStatus: () => true,
        },
      );

      const salesforceError = extractSalesforceError(response.data);
      if (response.status >= 400 || salesforceError) {
        return (
          salesforceError ?? {
            message: `HTTP ${response.status} ${response.statusText}`,
            raw: response.data,
          }
        );
      }

      // Salesforce PATCH often returns 204 No Content with no body id
      return { id: response.data?.id ?? caseId };
    } catch (error: any) {
      logger.error('Failed to patch Salesforce case approval status', { error });
      throw new Error(`patching error: ${error.message}`);
    }
  },
});
