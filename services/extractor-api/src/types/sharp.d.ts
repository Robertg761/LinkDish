declare module "sharp" {
  type SharpPipeline = {
    resize(options: { fit: "inside"; width: number; withoutEnlargement: boolean }): SharpPipeline;
    rotate(): SharpPipeline;
    toBuffer(): Promise<Buffer>;
    webp(options: { quality: number }): SharpPipeline;
  };

  type SharpFactory = (input: Buffer, options?: { failOn?: "none" }) => SharpPipeline;

  const sharp: SharpFactory;
  export default sharp;
}
