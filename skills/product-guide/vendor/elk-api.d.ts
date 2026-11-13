// 使う面だけの型宣言。ELK.js 本体は elk-api.js と elk-worker.min.js（vendor.ts が生成）。
declare class ELK {
  constructor(options: { workerFactory: (url: string) => unknown });
  layout(graph: object): Promise<object>;
}
export default ELK;
