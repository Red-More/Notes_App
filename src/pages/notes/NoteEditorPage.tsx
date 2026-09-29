import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { useLongPress } from "../../hooks";
import { diffLines, formatDateTime, fmtVersion } from "../../utils";
import type { Folder, NoteVersion } from "../../types";
import { ActionSheet, ConfirmDialog, Modal, toast } from "../../components/ui";
import {
    IconBack,
    IconBookmark,
    IconClock,
    IconCompare,
    IconDots,
    IconEye,
    IconFolder,
    IconRestore,
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

    // Label states
    const [labelMenuOpen, setLabelMenuOpen] = useState(false);
    const [createLabelOpen, setCreateLabelOpen] = useState(false);
    const [newLabelName, setNewLabelName] = useState("");
    const [newLabelDesc, setNewLabelDesc] = useState("");
    const [labelListOpen, setLabelListOpen] = useState(false);
    const [labelSheet, setLabelSheet] = useState<NoteVersion | null>(null);
    const [editLabelTarget, setEditLabelTarget] = useState<NoteVersion | null>(
        null,
    );
    const [editLabelName, setEditLabelName] = useState("");
    const [editLabelDesc, setEditLabelDesc] = useState("");
    const [deleteLabelConfirm, setDeleteLabelConfirm] =
        useState<NoteVersion | null>(null);

    // Load-version-to-editor states
    const [loadVersion, setLoadVersion] = useState<NoteVersion | null>(null);
    const [loadConfirm, setLoadConfirm] = useState(false);
    const [undoBackup, setUndoBackup] = useState<{
        title: string;
        content: string;
    } | null>(null);

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

    // Undo banner auto-dismiss after 5s.
    useEffect(() => {
        if (!undoBackup) return;
        const t = setTimeout(() => setUndoBackup(null), 5000);
        return () => clearTimeout(t);
    }, [undoBackup]);

    const handleBack = async () => {
        if (previewVersion) {
            setPreviewVersion(null);
            return;
        }
        if (labelMenuOpen) {
            setLabelMenuOpen(false);
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

    const performLoadVersion = (v: NoteVersion) => {
        setLoadVersion(null);
        setLoadConfirm(false);
        // Back up current content for undo, then fill the editor with the version.
        setUndoBackup({ title, content });
        setTitle(v.title);
        setContent(v.content);
        setPreviewVersion(null);
    };

    const handleLoadVersion = (v: NoteVersion) => {
        const dirty =
            title !== lastSavedRef.current.title ||
            content !== lastSavedRef.current.content;
        if (dirty) {
            setLoadVersion(v);
            setLoadConfirm(true);
        } else {
            performLoadVersion(v);
        }
    };

    // ---- Label helpers ----
    const handleCreateLabel = async () => {
        const name = newLabelName.trim();
        if (!name) {
            toast("请输入标签名称");
            return;
        }
        if (noteIdRef.current == null) {
            toast("请先输入内容以创建笔记");
            return;
        }
        try {
            await api.createLabel({
                noteId: noteIdRef.current,
                label: name,
                description: newLabelDesc.trim() || null,
            });
            setCreateLabelOpen(false);
            setNewLabelName("");
            setNewLabelDesc("");
            toast("标签已创建");
        } catch (e) {
            console.error(e);
            toast(String(e));
        }
    };

    const handleUpdateLabel = async () => {
        if (!editLabelTarget) return;
        const name = editLabelName.trim();
        if (!name) {
            toast("请输入标签名称");
            return;
        }
        try {
            await api.updateLabel({
                versionId: editLabelTarget.id,
                label: name,
                description: editLabelDesc.trim() || null,
            });
            setEditLabelTarget(null);
            await refreshVersions();
            toast("标签已更新");
        } catch (e) {
            console.error(e);
            toast(String(e));
        }
    };

    const handleDeleteLabel = async () => {
        const target = deleteLabelConfirm;
        setDeleteLabelConfirm(null);
        if (!target) return;
        try {
            await api.deleteLabel(target.id);
            await refreshVersions();
            toast("标签已删除");
        } catch (e) {
            console.error(e);
            toast("删除失败");
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

    const labeledVersions = versions.filter((v) => v.label);
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
                <button
                    type="button"
                    className="icon-btn accent"
                    onClick={() => setLabelMenuOpen((v) => !v)}
                    aria-label="标签"
                >
                    <IconBookmark size={20} />
                </button>
            </div>

            {labelMenuOpen && (
                <div className="label-menu">
                    <button
                        type="button"
                        className="label-menu-item"
                        onClick={() => {
                            setLabelMenuOpen(false);
                            setCreateLabelOpen(true);
                        }}
                    >
                        新建标签
                    </button>
                    <button
                        type="button"
                        className="label-menu-item"
                        onClick={() => {
                            setLabelMenuOpen(false);
                            void refreshVersions();
                            setLabelListOpen(true);
                        }}
                    >
                        标签列表
                    </button>
                </div>
            )}

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
                            onClick={() => handleLoadVersion(previewVersion)}
                        >
                            载入编辑
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

            {undoBackup && (
                <div className="undo-banner">
                    <span>已载入历史版本</span>
                    <button
                        type="button"
                        onClick={() => {
                            setTitle(undoBackup.title);
                            setContent(undoBackup.content);
                            setUndoBackup(null);
                        }}
                    >
                        撤销
                    </button>
                </div>
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
                <Modal title="历史版本" onClose={() => setVersionsOpen(false)}>
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

            {/* ---- Create label ---- */}
            {createLabelOpen && (
                <Modal
                    title="新建标签"
                    onClose={() => setCreateLabelOpen(false)}
                    footer={
                        <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => void handleCreateLabel()}
                        >
                            创建标签
                        </button>
                    }
                >
                    <div className="form-field">
                        <label className="form-label" htmlFor="label-name">
                            标签名称（必填，最多50字）
                        </label>
                        <input
                            id="label-name"
                            className="form-input"
                            value={newLabelName}
                            maxLength={50}
                            onChange={(e) => setNewLabelName(e.target.value)}
                            placeholder="例如：重要里程碑"
                        />
                    </div>
                    <div className="form-field">
                        <label className="form-label" htmlFor="label-desc">
                            标签描述（可选）
                        </label>
                        <textarea
                            id="label-desc"
                            className="form-textarea"
                            value={newLabelDesc}
                            onChange={(e) => setNewLabelDesc(e.target.value)}
                            placeholder="补充说明这个版本的用途"
                        />
                    </div>
                </Modal>
            )}

            {/* ---- Label list ---- */}
            {labelListOpen && (
                <Modal title="标签列表" onClose={() => setLabelListOpen(false)}>
                    {labeledVersions.length === 0 && (
                        <div className="empty-state">暂无标签</div>
                    )}
                    {labeledVersions.map((v) => (
                        <LabelRow
                            key={v.id}
                            version={v}
                            onPreview={() => {
                                setLabelListOpen(false);
                                setPreviewVersion(v);
                            }}
                            onActions={() => setLabelSheet(v)}
                        />
                    ))}
                </Modal>
            )}

            {/* ---- Label item actions ---- */}
            {labelSheet && (
                <ActionSheet
                    actions={[
                        {
                            text: "编辑标签",
                            onClick: () => {
                                setEditLabelTarget(labelSheet);
                                setEditLabelName(labelSheet.label ?? "");
                                setEditLabelDesc(
                                    labelSheet.labelDescription ?? "",
                                );
                            },
                        },
                        {
                            text: "删除标签",
                            danger: true,
                            onClick: () => setDeleteLabelConfirm(labelSheet),
                        },
                        {
                            text: "恢复到此版本",
                            onClick: () => {
                                setLabelListOpen(false);
                                setRestoreConfirm(labelSheet);
                            },
                        },
                    ]}
                    onCancel={() => setLabelSheet(null)}
                />
            )}

            {/* ---- Edit label ---- */}
            {editLabelTarget && (
                <Modal
                    title="编辑标签"
                    onClose={() => setEditLabelTarget(null)}
                    footer={
                        <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => void handleUpdateLabel()}
                        >
                            保存
                        </button>
                    }
                >
                    <div className="form-field">
                        <label className="form-label" htmlFor="edit-label-name">
                            标签名称
                        </label>
                        <input
                            id="edit-label-name"
                            className="form-input"
                            value={editLabelName}
                            maxLength={50}
                            onChange={(e) => setEditLabelName(e.target.value)}
                        />
                    </div>
                    <div className="form-field">
                        <label className="form-label" htmlFor="edit-label-desc">
                            标签描述
                        </label>
                        <textarea
                            id="edit-label-desc"
                            className="form-textarea"
                            value={editLabelDesc}
                            onChange={(e) => setEditLabelDesc(e.target.value)}
                        />
                    </div>
                </Modal>
            )}

            {deleteLabelConfirm && (
                <ConfirmDialog
                    title="删除标签"
                    message={`确定删除标签"${deleteLabelConfirm.label}"吗？版本内容会保留。`}
                    confirmText="删除"
                    danger
                    onConfirm={() => void handleDeleteLabel()}
                    onCancel={() => setDeleteLabelConfirm(null)}
                />
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

            {loadConfirm && loadVersion && (
                <ConfirmDialog
                    title="载入历史版本"
                    message="当前存在未保存的更改，加载历史版本将覆盖这些内容。"
                    confirmText="继续加载"
                    onConfirm={() => performLoadVersion(loadVersion)}
                    onCancel={() => setLoadConfirm(false)}
                />
            )}
        </div>
    );
}

/** A single labeled version row with long-press for actions. */
function LabelRow({
    version,
    onPreview,
    onActions,
}: {
    version: NoteVersion;
    onPreview: () => void;
    onActions: () => void;
}) {
    const { longPressProps, didLongPress } = useLongPress(onActions);
    return (
        <div
            className="version-item"
            onClick={() => {
                if (!didLongPress()) onPreview();
            }}
            {...longPressProps}
        >
            <div className="version-main">
                <div className="version-head">
                    <span className="version-label" style={{ maxWidth: 200 }}>
                        {version.label}
                    </span>
                    <span className="version-no">
                        {fmtVersion(version.versionNumber)}
                    </span>
                </div>
                {version.labelDescription && (
                    <div className="version-title">
                        {version.labelDescription}
                    </div>
                )}
                <div className="version-time">
                    {formatDateTime(version.createdAt)}
                </div>
            </div>
            <div className="version-actions">
                <button
                    type="button"
                    className="icon-btn"
                    aria-label="更多操作"
                    onClick={onActions}
                >
                    <IconDots size={18} />
                </button>
            </div>
        </div>
    );
}
