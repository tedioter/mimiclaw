export type ModelInfo = {
  id: string;
  model: string;
  baseUrl: string;
  active: boolean;
};

export type ModelControl = {
  listModels(): ModelInfo[];
  switchModel(id: string): void;
};
