export {};

declare global {
  interface Window {
    appHost: {
      ready(): void;
      invoke(capability: { provider: string; capability: string }, input: Record<string, unknown>, goal?: string): Promise<unknown>;
      onInit(callback: () => void): void;
    };
  }
}
