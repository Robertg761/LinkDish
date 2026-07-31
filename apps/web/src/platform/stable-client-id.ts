const CLIENT_ID_KEY = "linkdish:web:client-id:v1";

function generateUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      // Fallback if randomUUID fails for some reason
    }
  }

  // Fallback UUID v4 generator using getRandomValues
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const buffer = new Uint8Array(16);
    crypto.getRandomValues(buffer);
    
    // Set UUID version to 4 and variant to RFC 4122
    buffer[6] = (buffer[6]! & 0x0f) | 0x40;
    buffer[8] = (buffer[8]! & 0x3f) | 0x80;
    
    const hex = Array.from(buffer).map(b => b.toString(16).padStart(2, "0"));
    return [
      hex.slice(0, 4).join(""),
      hex.slice(4, 6).join(""),
      hex.slice(6, 8).join(""),
      hex.slice(8, 10).join(""),
      hex.slice(10, 16).join("")
    ].join("-");
  }

  // Pure math fallback (worst case if no crypto available, though modern browsers have it)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function getStableClientId(): string {
  if (typeof window === "undefined" || typeof localStorage === "undefined") {
    return "";
  }
  
  let clientId = localStorage.getItem(CLIENT_ID_KEY);
  if (!clientId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
    clientId = generateUUID();
    localStorage.setItem(CLIENT_ID_KEY, clientId);
  }
  
  return clientId;
}
