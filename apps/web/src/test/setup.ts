import { vi } from "vitest";
import "@testing-library/jest-dom";

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value.toString();
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    }
  };
})();

Object.defineProperty(window, "localStorage", {
  value: localStorageMock
});

// Mock matchMedia
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  }))
});

// Mock subtle crypto
const cryptoMock = {
  randomUUID: () => "12345678-1234-4321-1234-123456789012",
  subtle: {
    digest: async (algorithm: string, data: Uint8Array) => {
      await Promise.resolve();
      const buffer = new Uint8Array(32);
      // Create a deterministic mock hash based on input data
      for (let i = 0; i < data.length; i++) {
        buffer[i % 32] = (buffer[i % 32]! + data[i]!) % 256;
      }
      return buffer.buffer;
    }
  },
  getRandomValues: (buffer: Uint8Array) => {
    buffer.fill(1);
    return buffer;
  }
};

Object.defineProperty(window, "crypto", {
  value: cryptoMock
});
