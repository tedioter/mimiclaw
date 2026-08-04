import type { ModelRegistryInfo, ModelVendorInfo } from "../model/registry.js";

export type ModelInfo = ModelRegistryInfo;

export type ModelVendor = ModelVendorInfo;

export type ModelControl = {
  listVendors(): ModelVendor[];
  listModels(vendorId?: string): ModelRegistryInfo[];
  switchModel(model: string): void;
};
