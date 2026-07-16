export {};

declare global {
  interface Window {
    appHost: {
      theme: "light" | "dark" | null;
      ready(): void;
      invoke(capability: { provider: string; capability: string }, input: Record<string, unknown>, goal?: string): Promise<unknown>;
      onInit(callback: (context: { theme: "light" | "dark" }) => void): void;
    };
  }
}
