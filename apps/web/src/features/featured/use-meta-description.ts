import { useEffect } from "react";

/** Sets <meta name="description"> while mounted and restores the previous text afterwards. */
export const useMetaDescription = (description: string | null | undefined): void => {
  useEffect(() => {
    const text = description?.trim();

    if (!text) {
      return;
    }

    let meta = document.head.querySelector<HTMLMetaElement>('meta[name="description"]');
    const created = !meta;

    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "description";
      document.head.append(meta);
    }

    const previous = meta.content;
    meta.content = text;

    return () => {
      if (created) {
        meta.remove();
      } else {
        meta.content = previous;
      }
    };
  }, [description]);
};
