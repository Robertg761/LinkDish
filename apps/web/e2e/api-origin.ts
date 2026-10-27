/**
 * The API origin the E2E build talks to. `.invalid` never resolves, so a request the tests
 * forget to mock fails instead of reaching production (see fixtures.ts).
 */
export const E2E_API_ORIGIN = "https://api.e2e.invalid";
