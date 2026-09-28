import React from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it } from "vitest";

import { createPendingImageImport, getPendingImageImport } from "./pendingImageImports";
import { usePendingImageImport, type PendingImageImportState } from "./usePendingImageImport";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const renders: PendingImageImportState[] = [];

const Probe = ({ id }: { id: string | undefined }) => {
  renders.push(usePendingImageImport(id));
  return null;
};

describe("usePendingImageImport", () => {
  it("has the scan on the very first render and then releases it from memory", () => {
    renders.splice(0);
    const pending = createPendingImageImport([
      { dataUrl: "data:image/jpeg;base64,AAAA", mimeType: "image/jpeg" }
    ]);

    act(() => {
      create(<Probe id={pending.id} />);
    });

    expect(renders[0]).toMatchObject({ status: "ready" });
    expect(renders[0]?.pendingImport?.sourceUrl).toBe(pending.sourceUrl);
    expect(renders.at(-1)).toMatchObject({ status: "ready" });
    expect(getPendingImageImport(pending.id)).toBeUndefined();
  });

  it("reports a scan lost to process death instead of an empty screen", () => {
    renders.splice(0);

    act(() => {
      create(<Probe id="image-restored-after-process-death" />);
    });

    expect(renders.every((state) => state.status === "missing")).toBe(true);
  });

  it("is idle for routes that are not image imports", () => {
    renders.splice(0);

    act(() => {
      create(<Probe id={undefined} />);
    });

    expect(renders.at(-1)).toEqual({ pendingImport: undefined, status: "none" });
  });

  it("picks up a new scan when the route changes", () => {
    renders.splice(0);
    const first = createPendingImageImport([
      { dataUrl: "data:image/jpeg;base64,AAAA", mimeType: "image/jpeg" }
    ]);
    const second = createPendingImageImport([
      { dataUrl: "data:image/png;base64,BBBB", mimeType: "image/png" }
    ]);
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(<Probe id={first.id} />);
    });
    act(() => {
      renderer!.update(<Probe id={second.id} />);
    });

    expect(renders.at(-1)?.pendingImport?.id).toBe(second.id);
    expect(renders.at(-1)?.status).toBe("ready");
  });
});
