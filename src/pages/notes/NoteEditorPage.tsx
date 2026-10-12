import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { diffLines, formatDateTime, fmtVersion } from "../../utils";
import type { Folder, NoteVersion } from "../../types";
import { ConfirmDialog, Modal, toast } from "../../components/ui";
import {
    IconBack,
    IconClock,
    IconCompare,
    IconEye,
    IconFolder,
    IconPlus,
    IconRestore,
    IconTrash,
} from "../../components/Icons";

interface Props {
    noteId: number | null;
    folderId: number | null;
    onBack: () => void;
}

type SaveStatus = "idle" | "saving" | "saved";

export default function NoteEditorPage({ noteId, folderId, onBack }: Props) {
    const [title, setTitle] = useState("");
    const [content, setContent] = useState("");
    const [currentFolderId, setCurrentFolderId] = useState<number | null>(
        folderId,
    );
    const [folders, setFolders] = useState<Folder[]>([]);
    const [status, setStatus] = useState<SaveStatus>("idle");

    // Version states
    const [versionsOpen, setVersionsOpen] = useState(false);
    const [versions, setVersions] = useState<NoteVersion[]>([]);
    const [previewVersion, setPreviewVersion] = useState<NoteVersion | null>(
        null,
    );
    const [compareVersion, setCompareVersion] = useState<NoteVersion | null>(
        null,
    );
    const [restoreConfirm, setRestoreConfirm] = useState<NoteVersion | null>(
        null,
    );
    const [deleteVersionConfirm, setDeleteVersionConfirm] =
        useState<NoteVersion | null>(null);

    const [folderModalOpen, setFolderModalOpen] = useState(false);

    const noteIdRef = useRef<number | null>(noteId);
    const lastSavedRef = useRef<{ title: string; content: string }>({
        title: "",
        content: "",
    });

    // Load existing note and folder list on mount.
    useEffect(() => {
        void (async () => {
            try {
                setFolders((await api.listFolders()).folders);
                if (noteIdRef.current != null) {
                    const note = await api.getNote(noteIdRef.current);
                    setTitle(note.title);
                    setContent(note.content);
                    setCurrentFolderId(note.folderId);
                    lastSavedRef.current = {
                        title: note.title,
                        content: note.content,
                    };
                }
            } catch (e) {
                console.error("加载笔记失败", e);
                toast("加载失败");
            }
        })();
    }, []);

    // Skip saving a brand-new note that only contains whitespace.
    const isBlank = !title.trim() && !content.trim();

    const doSave = useCallback(
        async (force: boolean) => {
            if (
                title === lastSavedRef.current.title &&
                content === lastSavedRef.current.content
            ) {
                return;
            }
            if (noteIdRef.current == null && isBlank) return;
            setStatus("saving");
            try {
                if (noteIdRef.current == null) {
                    const note = await api.createNote({
                        title,
                        content,
                        folderId: currentFolderId,
                    });
                    noteIdRef.current = note.id;
                } else {
                    await api.saveNote({
                        id: noteIdRef.current,
                        title,
                        content,
                        folderId: currentFolderId,
                        forceVersion: force,
                    });
                }
                lastSavedRef.current = { title, content };
                setStatus("saved");
            } catch (e) {
                console.error("保存失败", e);
                setStatus("idle");
                toast("保存失败");
            }
        },
        [title, content, isBlank, currentFolderId],
    );

    // Auto-save 1s after content changes.
    useEffect(() => {
        if (
            title === lastSavedRef.current.title &&
            content === lastSavedRef.current.content
        )
            return;
        if (noteIdRef.current == null && isBlank) return;
        setStatus("saving");
        const t = setTimeout(() => void doSave(false), 1000);
        return () => clearTimeout(t);
    }, [title, content, isBlank, doSave]);

    const handleBack = async () => {
        if (previewVersion) {
            setPreviewVersion(null);
            return;
        }
        await doSave(true);
        onBack();
    };

    // ---- Version helpers ----
    const refreshVersions = async () => {
        if (noteIdRef.current == null) return;
        setVersions(await api.listVersions(noteIdRef.current));
    };

    const openVersions = async () => {
        if (noteIdRef.current == null) {
            toast("请先输入内容以创建笔记");
            return;
        }
        setVersionsOpen(true);
        try {
            await refreshVersions();
        } catch (e) {
            console.error(e);
            toast("加载版本失败");
        }
    };

    const handleRestore = async (v: NoteVersion) => {
        setRestoreConfirm(null);
        try {
            const note = await api.restoreVersion(v.id);
            setTitle(note.title);
            setContent(note.content);
            setCurrentFolderId(note.folderId);
            lastSavedRef.current = { title: note.title, content: note.content };
            setStatus("saved");
            setPreviewVersion(null);
            toast(`已恢复到 ${fmtVersion(v.versionNumber)}`);
            await refreshVersions();
        } catch (e) {
            console.error(e);
            toast("恢复失败");
        }
    };

    // ---- Version helpers ----
    const handleCreateVersion = async () => {
        if (noteIdRef.current == null) {
            toast("请先输入内容以创建笔记");
            return;
        }
        try {
            await api.createVersion(noteIdRef.current);
            await refreshVersions();
            toast("版本已创建");
        } catch (e) {
            console.error(e);
            toast(String(e));
        }
    };

    const handleDeleteVersion = async (v: NoteVersion) => {
        setDeleteVersionConfirm(null);
        try {
            await api.deleteVersion(v.id);
            toast("版本已删除");
            await refreshVersions();
        } catch (e) {
            console.error(e);
            toast(String(e));
        }
    };

    // ---- Folder selection ----
    const handleSelectFolder = async (fid: number | null) => {
        setFolderModalOpen(false);
        setCurrentFolderId(fid);
        if (noteIdRef.current == null) return;
        try {
            // Folder-only change: content unchanged so no version is created.
            await api.saveNote({
                id: noteIdRef.current,
                title,
                content,
                folderId: fid,
            });
            lastSavedRef.current = { title, content };
        } catch (e) {
            console.error(e);
            toast("移动失败");
        }
    };

    const folderName =
        folders.find((f) => f.id === currentFolderId)?.name ??
        (currentFolderId == null ? "默认" : "");

    const wordCount = content.length;
    const diffRows = compareVersion
        ? diffLines(compareVersion.content, content)
        : [];
    const diffAdd = diffRows.filter((r) => r.type === "add").length;
    const diffDel = diffRows.filter((r) => r.type === "del").length;

    return (
        <div className="editor-page">
            <div className="editor-topbar">
                <button
                    type="button"
                    className="icon-btn"
                    onClick={() => void handleBack()}
                    aria-label="返回"
                >
                    <IconBack size={22} />
                </button>
                <button
                    type="button"
                    className="editor-folder"
                    onClick={() => setFolderModalOpen(true)}
                >
                    <IconFolder size={15} />
                    <span>{folderName || "选择文件夹"}</span>
                </button>
                <span
                    className={`save-status ${status === "saving" ? "saving" : ""}`}
                >
                    {status === "saving"
                        ? "保存中…"
                        : status === "saved"
                          ? "已保存"
                          : ""}
                </span>
                <button
                    type="button"
                    className="icon-btn"
                    onClick={() => void openVersions()}
                    aria-label="历史版本"
                >
                    <IconClock size={20} />
                </button>
            </div>

            {previewVersion ? (
                <>
                    <div className="preview-banner">
                        历史版本预览 ·{" "}
                        {fmtVersion(previewVersion.versionNumber)}
                        {previewVersion.label
                            ? ` · ${previewVersion.label}`
                            : ""}
                    </div>
                    <div className="preview-content">
                        <div className="preview-title">
                            {previewVersion.title || "无标题"}
                        </div>
                        <div className="preview-text">
                            {previewVersion.content || "（无内容）"}
                        </div>
                    </div>
                    <div className="editor-bottombar">
                        <span>{previewVersion.content.length} 字</span>
                        <button
                            type="button"
                            className="btn btn-primary"
                            style={{ flex: "0 0 auto", padding: "8px 22px" }}
                            onClick={() => setRestoreConfirm(previewVersion)}
                        >
                            恢复版本
                        </button>
                    </div>
                </>
            ) : (
                <>
                    <div className="editor-body">
                        <input
                            className="editor-title-input"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder="标题"
                        />
                        <textarea
                            className="editor-content"
                            value={content}
                            onChange={(e) => setContent(e.target.value)}
                            placeholder="开始记录…"
                        />
                    </div>
                    <div className="editor-bottombar">
                        <span>{wordCount} 字</span>
                        <span>
                            {status === "saving"
                                ? "保存中…"
                                : status === "saved"
                                  ? "已保存"
                                  : "未修改"}
                        </span>
                    </div>
                </>
            )}

            {/* ---- Folder selector ---- */}
            {folderModalOpen && (
                <Modal
                    title="选择文件夹"
                    onClose={() => setFolderModalOpen(false)}
                >
                    <button
                        type="button"
                        className="option-row"
                        onClick={() => void handleSelectFolder(null)}
                    >
                        默认
                        {currentFolderId == null && (
                            <span className="row-check">✓</span>
                        )}
                    </button>
                    {folders.map((f) => (
                        <button
                            key={f.id}
                            type="button"
                            className="option-row"
                            onClick={() => void handleSelectFolder(f.id)}
                        >
                            <IconFolder size={18} />
                            {f.name}
                            {currentFolderId === f.id && (
                                <span className="row-check">✓</span>
                            )}
                        </button>
                    ))}
                </Modal>
            )}

            {/* ---- Version list ---- */}
            {versionsOpen && (
                <Modal
                    title="历史版本"
                    onClose={() => setVersionsOpen(false)}
                    headerAction={
                        <button
                            type="button"
                            className="icon-btn accent"
                            onClick={() => void handleCreateVersion()}
                            aria-label="新建版本"
                        >
                            <IconPlus size={20} />
                        </button>
                    }
                >
                    {versions.length === 0 && (
                        <div className="empty-state">暂无版本</div>
                    )}
                    {versions.map((v) => (
                        <div key={v.id} className="version-item">
                            <div
                                className="version-main"
                                onClick={() => {
                                    setVersionsOpen(false);
                                    setPreviewVersion(v);
                                }}
                            >
                                <div className="version-head">
                                    <span className="version-no">
                                        {fmtVersion(v.versionNumber)}
                                    </span>
                                    {v.label && (
                                        <span className="version-label">
                                            {v.label}
                                        </span>
                                    )}
                                </div>
                                <div className="version-title">
                                    {v.title || "无标题"}
                                </div>
                                <div className="version-time">
                                    {formatDateTime(v.createdAt)}
                                </div>
                            </div>
                            <div className="version-actions">
                                <button
                                    type="button"
                                    className="icon-btn"
                                    aria-label="预览"
                                    onClick={() => {
                                        setVersionsOpen(false);
                                        setPreviewVersion(v);
                                    }}
                                >
                                    <IconEye size={18} />
                                </button>
                                <button
                                    type="button"
                                    className="icon-btn"
                                    aria-label="恢复"
                                    onClick={() => setRestoreConfirm(v)}
                                >
                                    <IconRestore size={18} />
                                </button>
                                <button
                                    type="button"
                                    className="icon-btn"
                                    aria-label="对比"
                                    onClick={() => setCompareVersion(v)}
                                >
                                    <IconCompare size={18} />
                                </button>
                                <button
                                    type="button"
                                    className="icon-btn"
                                    aria-label="删除版本"
                                    onClick={() => setDeleteVersionConfirm(v)}
                                >
                                    <IconTrash size={18} />
                                </button>
                            </div>
                        </div>
                    ))}
                </Modal>
            )}

            {/* ---- Version compare ---- */}
            {compareVersion && (
                <Modal
                    title={`版本对比 · ${fmtVersion(compareVersion.versionNumber)} → 当前`}
                    onClose={() => setCompareVersion(null)}
                >
                    <div className="diff-stats">
                        <span className="add">+{diffAdd} 行新增</span>
                        <span className="del">-{diffDel} 行删除</span>
                    </div>
                    <div className="diff-body">
                        {diffRows.map((row, idx) => (
                            <div key={idx} className={`diff-row ${row.type}`}>
                                <span className="no">
                                    {row.type === "add"
                                        ? row.newNo
                                        : (row.oldNo ?? "")}
                                </span>
                                <span>{row.text || " "}</span>
                            </div>
                        ))}
                    </div>
                </Modal>
            )}

            {restoreConfirm && (
                <ConfirmDialog
                    title="恢复版本"
                    message={`确定要恢复到 ${fmtVersion(restoreConfirm.versionNumber)} 吗？当前内容将被覆盖，并自动创建一个"恢复自"版本。`}
                    confirmText="恢复"
                    onConfirm={() => void handleRestore(restoreConfirm)}
                    onCancel={() => setRestoreConfirm(null)}
                />
            )}

            {deleteVersionConfirm && (
                <ConfirmDialog
                    title="删除版本"
                    message={`确定要删除 ${fmtVersion(deleteVersionConfirm.versionNumber)} 这个版本吗？此操作不可撤销。`}
                    confirmText="删除"
                    onConfirm={() => void handleDeleteVersion(deleteVersionConfirm)}
                    onCancel={() => setDeleteVersionConfirm(null)}
                />
            )}
        </div>
    );
}

