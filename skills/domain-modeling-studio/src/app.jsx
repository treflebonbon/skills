import {
  ReactFlow,
  useReactFlow,
  useStore,
  Background,
  Controls,
  Handle,
  Position,
  NodeResizer,
  MarkerType,
} from "@xyflow/react";
import React, { memo, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  KINDS,
  ARCHITECTURE_KINDS,
  FLOW_KINDS,
  ORIGINS,
  validateDocument,
  signature,
  reconcile,
  withRevisionHistory,
  editItem,
  removeItem,
  feedback,
  artifacts,
} from "./model.mjs";

import "@xyflow/react/dist/style.css";
import "./style.css";

const uid = () => crypto.randomUUID();
const names = { current: "現状", proposed: "改善案" };
const LAYERS = [
  { id: "architecture", kinds: ARCHITECTURE_KINDS, label: "アーキテクチャ" },
  { id: "flow", kinds: FLOW_KINDS, label: "関数フロー" },
  { id: "business", kinds: KINDS, label: "業務フロー" },
];
const LAYER_KINDS = Object.fromEntries(LAYERS.map((l) => [l.id, l.kinds]));
const layerOf = (kind) => LAYERS.find((l) => l.kinds.includes(kind)).id;
const NEW_NODE_DEFAULTS = {
  architecture: { kind: "MODULE", label: "新しいモジュール" },
  business: { kind: "PROCESS", label: "新しい業務" },
  flow: { kind: "STAGE", label: "新しいステージ" },
};
// Isolated so drillInto lookup doesn't add to App's own cyclomatic complexity.
const deriveLayerView = (graph, layer, selected) => {
  const layerKinds = LAYER_KINDS[layer];
  const layerNodes = graph.nodes.filter((n) =>
    layerKinds.includes(n.data.kind)
  );
  const layerNodeIds = new Set(layerNodes.map((n) => n.id));
  const layerEdges = graph.edges.filter(
    (e) => layerNodeIds.has(e.source) && layerNodeIds.has(e.target)
  );
  // An edge with exactly one endpoint in this layer is schema-valid
  // (model.md's cross-layer section) but would never satisfy layerEdges'
  // both-endpoints test in any single layer, so it must stay reachable for
  // review even though the canvas can't place its other endpoint here.
  const crossLayerEdges = graph.edges.filter(
    (e) => layerNodeIds.has(e.source) !== layerNodeIds.has(e.target)
  );
  const drillTarget =
    selected?.data?.drillInto &&
    graph.nodes.find((n) => n.id === selected.data.drillInto);
  return { crossLayerEdges, drillTarget, layerEdges, layerKinds, layerNodes };
};
const download = (name, content) => {
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/plain;charset=utf-8" })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const DomainNode = memo(({ data, selected }) => (
  <div className={`domain-node kind-${data.kind}`}>
    <NodeResizer
      minWidth={100}
      minHeight={60}
      isVisible={selected}
      onResizeStart={data.startGesture}
      onResizeEnd={data.endGesture}
    />
    <Handle type="target" position={Position.Left} />
    <span className="node-kind">{data.kind}</span>
    <strong>{data.label}</strong>
    <span className="node-origin">{ORIGINS[data.origin]}</span>
    <Handle type="source" position={Position.Right} />
  </div>
));
const FitOnResize = () => {
  const { fitView } = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  useEffect(() => {
    if (width && height) {
      void fitView();
    }
  }, [width, height, fitView]);
  return null;
};
const nodeTypes = { domain: DomainNode };
const load = (seed) => {
  let raw;
  try {
    raw = localStorage.getItem(`domain-studio:${seed.sessionId}`);
    const saved = raw ? JSON.parse(raw) : null;
    return { ...reconcile(seed, saved), error: "", raw, saved };
  } catch (error) {
    return {
      conflict: Boolean(raw),
      document: seed,
      error: `下書きを読み込めません。${error.message}`,
      lastExport: null,
      raw,
      saved: null,
    };
  }
};
const Evidence = ({ evidence }) =>
  evidence.length ? (
    <ul className="evidence">
      {evidence.map((ref, i) => (
        <li key={`${ref.path}-${i}`}>
          <code>
            {ref.path}
            {ref.line ? `:${ref.line}` : ""}
          </code>
          <span>{ref.symbol}</span>
          <small>参照版 {ref.revision}</small>
        </li>
      ))}
    </ul>
  ) : (
    <p className="muted">コードの根拠は未登録です。</p>
  );
const Inspector = ({
  doc,
  graph,
  allNodes,
  crossLayerEdgeIds,
  kinds,
  selected,
  selection,
  setSelection,
  view,
  editable,
  edit,
  update,
  target,
  comment,
  setComment,
  draftTarget,
  commitDraft,
  drillTarget,
  onDrillInto,
}) => (
  <aside className="inspector" aria-label="根拠と指摘">
    <label>
      レビュー対象
      <select
        aria-label="レビュー対象"
        value={selected ? `${selection.entity}:${selected.id}` : "whole"}
        onChange={(e) => {
          const [entity, id] = e.target.value.split(":");
          setSelection(id ? { entity, id } : null);
        }}
      >
        <option value="whole">全体フロー・境界</option>
        {graph.nodes.map((n) => (
          <option key={n.id} value={`node:${n.id}`}>
            {n.data.label}
          </option>
        ))}
        {graph.edges.map((e) => (
          <option key={e.id} value={`edge:${e.id}`}>
            関係: {e.label || e.id}
            {crossLayerEdgeIds?.has(e.id) ? "（他レイヤー）" : ""}
          </option>
        ))}
      </select>
    </label>
    <h2>
      {selected ? (selected.data.label ?? selected.label) : "全体フロー・境界"}
    </h2>
    {selected && (
      <div key={`${view}-${selected.id}`}>
        <p className="provenance">
          {ORIGINS[selected.data.origin]} <small>{selected.id}</small>
        </p>
        <label>
          {selection.entity === "node" ? "名称" : "条件ラベル"}
          <input
            aria-label={selection.entity === "node" ? "名称" : "条件ラベル"}
            readOnly={!editable}
            value={selected.data.label ?? selected.label}
            onChange={(e) =>
              edit(
                selection.entity === "node"
                  ? {
                      data: {
                        ...selected.data,
                        label: e.target.value || "名称未入力",
                      },
                    }
                  : { label: e.target.value }
              )
            }
          />
        </label>
        {selection.entity === "node" ? (
          <>
            <label>
              種別
              <select
                disabled={!editable}
                value={selected.data.kind}
                onChange={(e) =>
                  edit({
                    data: { ...selected.data, kind: e.target.value },
                  })
                }
              >
                {kinds.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
            <div className="geometry">
              {["x", "y", "width", "height"].map((key) => (
                <label key={key}>
                  {key}
                  <input
                    type="number"
                    aria-label={key}
                    value={
                      ["x", "y"].includes(key)
                        ? selected.position[key]
                        : selected[key]
                    }
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      edit(
                        ["x", "y"].includes(key)
                          ? {
                              position: {
                                ...selected.position,
                                [key]: v,
                              },
                            }
                          : { [key]: v }
                      );
                    }}
                  />
                </label>
              ))}
            </div>
          </>
        ) : (
          <div className="geometry">
            {[
              ["source", "接続元"],
              ["target", "接続先"],
            ].map(([key, label]) => (
              <label key={key}>
                {label}
                <select
                  aria-label={label}
                  disabled={!editable}
                  value={selected[key]}
                  onChange={(e) => edit({ [key]: e.target.value })}
                >
                  {(crossLayerEdgeIds?.has(selected.id)
                    ? allNodes
                    : graph.nodes
                  ).map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.data.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        )}
        {drillTarget && (
          <button onClick={onDrillInto}>
            ドリルダウン: {drillTarget.data.label}
          </button>
        )}
        {editable && (
          <button
            className="danger"
            onClick={() => {
              update((d) => removeItem(d, selection.entity, selected.id));
              setSelection(null);
            }}
          >
            選択対象を削除
          </button>
        )}
        <h3>参照した根拠</h3>
        {selected.data.origin === "proposal" && (
          <p className="muted">
            変更後は未検証です。下の根拠は変更前からの参照情報です。
          </p>
        )}
        <Evidence evidence={selected.data.evidence} />
      </div>
    )}
    <h3>指摘・例外・訂正</h3>
    {doc.comments
      .filter((c) => c.target.view === target.view && c.target.id === target.id)
      .map((c) => (
        <p className="comment" key={c.id}>
          {c.text}
        </p>
      ))}
    <label>
      指摘を入力
      {comment && <small>入力先: {draftTarget.current?.id ?? "全体"}</small>}
      <textarea
        value={comment}
        onChange={(e) => {
          const { value } = e.target;
          // Clearing the draft (not just submitting it) must also drop the
          // captured target, or a fresh draft started after reselecting gets
          // silently attributed to whatever was selected when typing began.
          draftTarget.current = value ? (draftTarget.current ?? target) : null;
          setComment(value);
        }}
        rows={4}
        placeholder="認識の違い、例外条件、境界の疑問を記入"
      />
    </label>
    <button onClick={commitDraft}>指摘を追加</button>
    <details>
      <summary>削除した対象と指摘（{doc.retired.length}）</summary>
      {doc.retired.map((r, i) => (
        <div key={`${r.item.id}-${i}`}>
          <strong>{r.item.data.label ?? r.item.label ?? r.item.id}</strong>
          <small>{r.item.id}</small>
          {doc.comments
            .filter(
              (c) => c.target.view === r.view && c.target.id === r.item.id
            )
            .map((c) => (
              <p key={c.id}>{c.text}</p>
            ))}
        </div>
      ))}
    </details>
    <details open={doc.unresolved.length > 0}>
      <summary>未解決事項（{doc.unresolved.length}）</summary>
      <ul>
        {doc.unresolved.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </details>
  </aside>
);

const Status = ({
  storageError,
  conflict,
  pending,
  initial,
  setPending,
  setConflict,
  setMessage,
  dirtyAfterCopy,
  doc,
  message,
}) => (
  <>
    {storageError && (
      <p className="warning" role="alert">
        {storageError}
      </p>
    )}
    {conflict && (
      <section className="warning" aria-label="更新の競合">
        <strong>
          編集を保護しています。現在の内容をAIへ渡し直してください。
        </strong>
        <p>
          AI更新版の基準・版番号・保持すべき記録が一致しないため、自動上書きしていません。
        </p>
        <div className="actions">
          {pending && (
            <button
              onClick={() =>
                download(
                  "ai-update-pending.json",
                  JSON.stringify(pending, null, 2)
                )
              }
            >
              保留中のAI更新を保存
            </button>
          )}
          {initial.raw && (
            <button
              onClick={() =>
                download("previous-browser-draft.json", initial.raw)
              }
            >
              元の下書きを退避
            </button>
          )}
          <button
            onClick={() => {
              setPending(null);
              setConflict(false);
              setMessage(
                "現在の編集を継続します。次のコピーをAIへ渡してください。"
              );
            }}
          >
            現在の編集を続ける
          </button>
        </div>
      </section>
    )}
    {dirtyAfterCopy && (
      <p className="warning" role="alert">
        コピー後に変更があります。更新を受け取る前に、もう一度コピーしてAIへ渡してください。
      </p>
    )}
    {doc.needsReview && (
      <p className="notice">
        モデルを編集しました。用語・BDD・実装変更候補はAIの再確認待ちです。
      </p>
    )}
    <p className="message" role="status">
      {message}
    </p>
  </>
);
const App = ({ seed }) => {
  const [initial] = useState(() => load(seed));
  const [doc, setDoc] = useState(initial.document);
  const docRef = useRef(doc);
  const [view, setView] = useState("current");
  const [layer, setLayer] = useState("business");
  const [selection, setSelection] = useState(null);
  const [filter, setFilter] = useState("ALL");
  const [tab, setTab] = useState("model");
  const [past, setPast] = useState([]);
  const [future, setFuture] = useState([]);
  const [lastExport, setLastExport] = useState(initial.lastExport);
  const [conflict, setConflict] = useState(initial.conflict);
  const [backup, setBackup] = useState(null);
  const [pending, setPending] = useState(initial.conflict ? seed : null);
  const [storageError, setStorageError] = useState(initial.error);
  const [message, setMessage] = useState("");
  const [copyText, setCopyText] = useState("");
  const [comment, setComment] = useState(initial.saved?.comment ?? "");
  const outputRef = useRef(null);
  const draftTarget = useRef(initial.saved?.draftTarget ?? null);
  const prepared = useRef(null);
  const gesture = useRef(null);
  const seedRef = useRef(
    initial.conflict && initial.saved ? initial.saved.seed : signature(seed)
  );
  const graph = doc.models[view];
  const editable = view === "proposed";
  const selected =
    selection &&
    graph[selection.entity === "node" ? "nodes" : "edges"].find(
      (n) => n.id === selection.id
    );
  const target = selected ? { id: selected.id, view } : { view: "whole" };
  const { crossLayerEdges, drillTarget, layerEdges, layerKinds, layerNodes } =
    deriveLayerView(graph, layer, selected);
  const crossLayerEdgeIds = new Set(crossLayerEdges.map((e) => e.id));
  const goToDrillTarget = () => {
    if (!drillTarget) {
      return;
    }
    setLayer(layerOf(drillTarget.data.kind));
    setFilter("ALL");
    setSelection({ entity: "node", id: drillTarget.id });
  };
  const dirtyAfterCopy = lastExport && lastExport.signature !== signature(doc);
  useEffect(() => {
    document.title = doc.title;
  }, [doc.title]);
  useEffect(() => {
    if (conflict) {
      return;
    }
    try {
      localStorage.setItem(
        `domain-studio:${doc.sessionId}`,
        JSON.stringify({
          comment,
          document: doc,
          draftTarget: draftTarget.current,
          lastExport,
          seed: seedRef.current,
        })
      );
      setStorageError("");
    } catch {
      setStorageError(
        "ブラウザに保存できません。「JSONを保存」で内容を退避してください。"
      );
    }
  }, [doc, lastExport, conflict, comment]);
  useEffect(() => {
    const warn = (event) => {
      if (dirtyAfterCopy || storageError || conflict || comment.trim()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirtyAfterCopy, storageError, conflict, comment]);
  const remember = (value) => {
    // ponytail: retain 100 snapshots; use command history if large models need longer undo.
    setPast((items) => [...items.slice(-99), value]);
    setFuture([]);
  };
  const update = (fn, checkpoint = true) => {
    try {
      const before = docRef.current;
      const next = validateDocument(fn(structuredClone(before)));
      if (signature(before) === signature(next)) {
        return;
      }
      if (checkpoint) {
        remember(before);
      }
      docRef.current = next;
      setDoc(next);
      setMessage("");
    } catch (error) {
      setMessage(error.message);
    }
  };
  const startGesture = () => {
    gesture.current ??= docRef.current;
  };
  const endGesture = () => {
    if (
      gesture.current &&
      signature(gesture.current) !== signature(docRef.current)
    ) {
      remember(gesture.current);
    }
    gesture.current = null;
  };
  const edit = (patch) =>
    update((d) => editItem(d, view, selection.entity, selected.id, patch));
  const undo = () => {
    if (!past.length) {
      return;
    }
    setFuture((items) => [...items, docRef.current]);
    const next = past.at(-1);
    setPast((items) => items.slice(0, -1));
    docRef.current = next;
    setDoc(next);
  };
  const redo = () => {
    if (!future.length) {
      return;
    }
    setPast((items) => [...items, docRef.current]);
    const next = future.at(-1);
    setFuture((items) => items.slice(0, -1));
    docRef.current = next;
    setDoc(next);
  };
  const onNodesChange = (changes) => {
    const useful = changes.filter(
      (c) =>
        (c.type === "position" && c.position) ||
        (c.type === "dimensions" && c.resizing !== undefined)
    );
    if (!useful.length) {
      return;
    }
    startGesture();
    update((d) => {
      for (const change of useful) {
        const node = d.models[view].nodes.find((n) => n.id === change.id);
        if (node && change.position) {
          node.position = change.position;
        }
        if (node && change.dimensions) {
          Object.assign(node, change.dimensions);
        }
      }
      return d;
    }, false);
    if (useful.some((c) => c.dragging === false || c.resizing === false)) {
      endGesture();
    }
  };
  const connect = ({ source, target: to }) => {
    if (!editable || !source || !to) {
      return;
    }
    update((d) => {
      d.models.proposed.edges.push({
        data: { evidence: [], origin: "proposal" },
        id: uid(),
        label: "条件未確認",
        source,
        target: to,
      });
      d.needsReview = true;
      return d;
    });
  };
  const addNode = () => {
    const newId = uid();
    const { kind, label } = NEW_NODE_DEFAULTS[layer];
    update((d) => {
      d.models.proposed.nodes.push({
        data: {
          evidence: [],
          kind,
          label,
          origin: "proposal",
        },
        height: 100,
        id: newId,
        position: { x: 80 + d.models.proposed.nodes.length * 20, y: 160 },
        width: 180,
      });
      d.needsReview = true;
      return d;
    });
    setSelection({ entity: "node", id: newId });
  };
  const commitDraft = () => {
    if (comment.trim()) {
      update((d) => {
        d.comments.push({
          id: uid(),
          target: draftTarget.current ?? target,
          text: comment.trim(),
        });
        return d;
      });
      setComment("");
      draftTarget.current = null;
    }
    return docRef.current;
  };
  const prepareCopy = async () => {
    const document = commitDraft();
    const exportId = uid();
    const content = feedback(document, exportId);
    const record = { id: exportId, signature: signature(document) };
    prepared.current = record;
    setCopyText(content);
    try {
      await navigator.clipboard.writeText(content);
      setLastExport(record);
      setMessage(
        "コピーしました。チャットへ貼り付けてください（送信はまだ確認されていません）。"
      );
    } catch {
      setMessage(
        "自動コピーできません。下の選択された回答をCtrl+C / ⌘Cでコピーしてください。"
      );
      requestAnimationFrame(() => {
        outputRef.current?.focus();
        outputRef.current?.select();
      });
    }
  };
  const restoreBackup = () => {
    download(
      "before-restore.json",
      JSON.stringify(
        { document: commitDraft(), format: "domain-studio-backup-v1" },
        null,
        2
      )
    );
    seedRef.current = signature(seed);
    const restored = withRevisionHistory(backup, docRef.current);
    docRef.current = restored;
    setDoc(restored);
    setLastExport(null);
    setPast([]);
    setFuture([]);
    setSelection(null);
    setConflict(false);
    setPending(null);
    setMessage(
      "保存JSONを復元しました。必要に応じてAIへコピーし直してください。"
    );

    setBackup(null);
  };
  const importDocument = async (event) => {
    const [file] = event.target.files;
    if (!file) {
      return;
    }
    try {
      if (file.size > 10_000_000) {
        throw new Error("JSONは10MB以下にしてください");
      }
      const parsed = JSON.parse(await file.text());
      if (parsed.format === "domain-studio-backup-v1") {
        const restored = validateDocument(parsed.document);
        if (restored.sessionId !== doc.sessionId) {
          throw new Error("別セッションの保存JSONです");
        }
        setBackup(restored);
        return;
      }
      const incoming = validateDocument(parsed);
      if (incoming.sessionId !== doc.sessionId) {
        throw new Error("別セッションです。別のHTMLで開いてください");
      }
      const result = reconcile(incoming, {
        document: commitDraft(),
        lastExport,
        seed: seedRef.current,
      });
      if (result.conflict) {
        setPending(incoming);
        setConflict(true);
        setMessage(
          "基準版・版番号・コピー後の編集、または保持すべき記録が一致しません。現在の編集をAIへ渡し直してください。"
        );
      } else {
        seedRef.current = signature(incoming);
        docRef.current = result.document;
        setDoc(result.document);
        setLastExport(result.lastExport);
        setPast([]);
        setFuture([]);
        setSelection(null);
        setConflict(false);
        setPending(null);
        setMessage("AI更新版を取り込みました。");
      }
    } catch (error) {
      setMessage(`取り込めません。${error.message}`);
    } finally {
      event.target.value = "";
    }
  };
  let storageStatus = "ブラウザ下書き保存";
  if (conflict) {
    storageStatus = "下書き保護中";
  }
  if (storageError) {
    storageStatus = "保存に問題あり";
  }
  const files = artifacts(doc);
  const artifactName = {
    bdd: "scenarios.feature",
    changes: "changes.md",
    glossary: "glossary.md",
    model: "model.md",
  }[tab];
  const visibleNodes = layerNodes.filter(
    (n) => filter === "ALL" || n.data.kind === filter
  );
  const visibleIds = new Set(visibleNodes.map((n) => n.id));
  return (
    <main>
      <header className="topbar">
        <div>
          <h1>{doc.title}</h1>
          <p>
            {doc.repository.name}{" "}
            <span className="revision">
              {doc.repository.revision.slice(0, 12)}
            </span>
            <span className="revision">
              セッション: {doc.sessionId} · 版: {doc.revision}
            </span>
          </p>
        </div>
        <div className="actions">
          <button
            onClick={() =>
              download(
                `${doc.sessionId}-${doc.revision}.json`,
                JSON.stringify(
                  {
                    document: commitDraft(),
                    format: "domain-studio-backup-v1",
                  },
                  null,
                  2
                )
              )
            }
          >
            JSONを保存
          </button>
          <label className="file-button">
            JSONを読み込む
            <input
              type="file"
              accept=".json,application/json"
              onChange={importDocument}
            />
          </label>
          <button className="primary" onClick={prepareCopy}>
            指摘・モデルをコピー
          </button>
        </div>
      </header>
      {backup && (
        <section className="warning" aria-label="保存版の復元">
          <p>
            現在の内容をJSONに退避して、保存版（{backup.revision}
            ）を復元します。
          </p>
          <button onClick={restoreBackup}>退避して保存版を復元</button>
          <button onClick={() => setBackup(null)}>復元をキャンセル</button>
        </section>
      )}
      <div className="statusline">
        <span>{doc.scope}</span>
        <span>
          {doc.revision} · {storageStatus}
        </span>
      </div>
      <Status
        storageError={storageError}
        conflict={conflict}
        pending={pending}
        initial={initial}
        setPending={setPending}
        setConflict={setConflict}
        setMessage={setMessage}
        dirtyAfterCopy={dirtyAfterCopy}
        doc={doc}
        message={message}
      />
      <nav className="tabs" aria-label="ワークスペース">
        {[
          ["model", "モデルをレビュー"],
          ["glossary", "用語辞書"],
          ["bdd", "BDD草案"],
          ["changes", "実装変更候補"],
        ].map(([id, label]) => (
          <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>
      {tab === "model" ? (
        <>
          <section className="toolbar" aria-label="図の操作">
            <div className="segmented">
              {["current", "proposed"].map((v) => (
                <button
                  key={v}
                  aria-pressed={view === v}
                  onClick={() => {
                    setView(v);
                    setSelection(null);
                  }}
                >
                  {names[v]}
                </button>
              ))}
            </div>
            <div className="segmented" role="group" aria-label="レイヤー">
              {LAYERS.map((l) => (
                <button
                  key={l.id}
                  aria-pressed={layer === l.id}
                  onClick={() => {
                    setLayer(l.id);
                    setFilter("ALL");
                    setSelection(null);
                  }}
                >
                  {l.label}
                </button>
              ))}
            </div>
            <label>
              種別
              <select
                aria-label="種別フィルター"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="ALL">すべて</option>
                {layerKinds.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
            <button onClick={undo} disabled={!past.length}>
              元に戻す
            </button>
            <button onClick={redo} disabled={!future.length}>
              やり直す
            </button>
            <button onClick={addNode} disabled={!editable}>
              要素を追加
            </button>
            <button
              disabled={!editable || layerNodes.length < 2}
              onClick={() =>
                connect({
                  source: layerNodes[0].id,
                  target: layerNodes[1].id,
                })
              }
            >
              関係を追加
            </button>
            <span className="muted">
              {editable
                ? "改善案を直接編集できます"
                : "現状の訂正は右側に指摘してください"}
            </span>
          </section>
          <div className="workspace">
            <section
              className="canvas"
              aria-label={`${names[view]}の業務フロー`}
            >
              <ReactFlow
                key={`${view}-${layer}`}
                nodeTypes={nodeTypes}
                nodes={visibleNodes.map((n) => ({
                  data: {
                    endGesture,
                    kind: n.data.kind,
                    label: n.data.label,
                    origin: n.data.origin,
                    startGesture,
                  },
                  height: n.height,
                  id: n.id,
                  position: n.position,
                  selected: selection?.id === n.id,
                  style: { height: n.height, width: n.width },
                  type: "domain",
                  width: n.width,
                }))}
                edges={layerEdges
                  .filter(
                    (e) => visibleIds.has(e.source) && visibleIds.has(e.target)
                  )
                  .map((e) => ({
                    id: e.id,
                    label: e.label,
                    markerEnd: { type: MarkerType.ArrowClosed },
                    selected: selection?.id === e.id,
                    source: e.source,
                    style: { stroke: "#50676b", strokeWidth: 1.6 },
                    target: e.target,
                  }))}
                onNodesChange={onNodesChange}
                onNodeDragStart={startGesture}
                onNodeDragStop={endGesture}
                onNodeClick={(_, n) =>
                  setSelection({ entity: "node", id: n.id })
                }
                onEdgeClick={(_, e) =>
                  setSelection({ entity: "edge", id: e.id })
                }
                onPaneClick={() => setSelection(null)}
                onConnect={connect}
                nodesConnectable={editable}
                deleteKeyCode={null}
                fitView
                minZoom={0.15}
                maxZoom={2}
              >
                <FitOnResize />
                <Background gap={24} color="#d2dddd" />
                <Controls showInteractive={false} />
              </ReactFlow>
            </section>
            <Inspector
              doc={doc}
              graph={{
                edges: [...layerEdges, ...crossLayerEdges],
                nodes: layerNodes,
              }}
              allNodes={graph.nodes}
              crossLayerEdgeIds={crossLayerEdgeIds}
              kinds={layerKinds}
              selected={selected}
              selection={selection}
              setSelection={setSelection}
              view={view}
              editable={editable}
              edit={edit}
              update={update}
              target={target}
              comment={comment}
              setComment={setComment}
              draftTarget={draftTarget}
              commitDraft={commitDraft}
              drillTarget={drillTarget}
              onDrillInto={goToDrillTarget}
            />
          </div>
        </>
      ) : (
        <section className="artifacts">
          <h2>
            {
              {
                bdd: "Gherkinシナリオ草案",
                changes: "実装変更候補",
                glossary: "ユビキタス言語辞書",
              }[tab]
            }
          </h2>
          <p>
            内容の訂正・追加は全体への指摘としてAIに渡してください。合意とコードの確認を区別して更新します。
          </p>
          <pre>{files[artifactName]}</pre>
        </section>
      )}
      <footer>
        <button onClick={() => download(artifactName, files[artifactName])}>
          {artifactName}を保存
        </button>
        <span className="muted">
          単一HTML・外部通信なし ／ 根拠と合意を分けて記録
        </span>
      </footer>
      {copyText && (
        <section className="export">
          <h2>AIへ渡すMarkdown</h2>
          <p>図のJSONも含め、全体をコピーしてチャットへ貼り付けてください。</p>
          <textarea
            aria-label="AIへ渡すMarkdown"
            ref={outputRef}
            value={copyText}
            readOnly
            rows={8}
          />
          <button
            onClick={() => {
              setLastExport(prepared.current);
              setMessage(
                "手動コピーを記録しました。チャットへの貼り付けは別操作です。"
              );
            }}
          >
            手動でコピーしたことを記録
          </button>
        </section>
      )}
    </main>
  );
};
try {
  const seed = validateDocument(
    JSON.parse(document.querySelector("#studio-document").textContent)
  );
  createRoot(document.querySelector("#root")).render(<App seed={seed} />);
} catch (error) {
  document.querySelector("#root").textContent =
    `モデルを開けません。生成元JSONを確認してください。${error.message}`;
}
