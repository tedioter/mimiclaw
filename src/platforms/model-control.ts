import type { ModelRuntimeInfo, ModelVendorInfo } from "../model/runtime.js";

export type ModelInfo = ModelRuntimeInfo;

export type ModelVendor = ModelVendorInfo;

export type ModelControl = {
  listVendors(): ModelVendor[];
  listModels(vendorId?: string): ModelRuntimeInfo[];
  switchModel(id: string): void;
};
