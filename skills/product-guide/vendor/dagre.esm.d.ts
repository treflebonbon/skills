// 使う面だけの型宣言。Dagre 本体は dagre.esm.js（vendor.ts が生成）。
declare const dagre: {
  graphlib: {
    Graph: new () => {
      setGraph(label: Record<string, unknown>): void;
      setDefaultEdgeLabel(fn: () => Record<string, unknown>): void;
      setNode(id: string, label: { width: number; height: number }): void;
      setEdge(from: string, to: string): void;
      edge(from: string, to: string): { points: { x: number; y: number }[] };
      node(id: string): { x: number; y: number; width: number; height: number };
      graph(): { width?: number; height?: number };
    };
  };
  layout(graph: InstanceType<typeof dagre.graphlib.Graph>): void;
};
export default dagre;
