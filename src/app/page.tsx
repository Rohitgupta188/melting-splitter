"use client";

import React, { useState, useCallback } from "react";
import {
  Upload,
  FileDown,
  RefreshCw,
  AlertCircle,
  CheckCircle,
  FileText,
  Layers,
  ImageIcon,
  Zap,
  Archive,
  Loader2,
} from "lucide-react";
import JSZip from "jszip";
import { saveAs } from "file-saver";

import { parsePDF } from "@/lib/pdf-parser";
import { groupRows, GroupedData } from "@/lib/grouping";
import {
  resolveImages,
  getImageStats,
  resetImageState,
  ImageStats,
} from "@/lib/image-service";
import { generateGroupPdfBlob } from "@/lib/generateSplitPdf";
import { ParsedRow, QuotationHeader } from "@/lib/types";

// ─── Types ───────────────────────────────────────────────────────────────────

type Stage =
  | "IDLE"
  | "READING_PDF"
  | "PARSING_ROWS"
  | "REVIEW_GROUPS"
  | "FETCHING_IMAGES"
  | "GENERATING_PDFS"
  | "CREATING_ZIP"
  | "COMPLETED"
  | "ERROR";

interface ProcessLog {
  totalRows: number;
  groups: GroupedData[];
  imageStats: ImageStats;
  pdfsGenerated: number;
  elapsedSeconds: number;
}

// ─── Stage step config ───────────────────────────────────────────────────────

const PIPELINE_STEPS: { stage: Stage; label: string; icon: React.ElementType }[] = [
  { stage: "READING_PDF",    label: "Reading PDF",      icon: FileText    },
  { stage: "PARSING_ROWS",   label: "Parsing rows",     icon: Layers      },
  { stage: "FETCHING_IMAGES",label: "Fetching images",  icon: ImageIcon   },
  { stage: "GENERATING_PDFS",label: "Generating PDFs",  icon: Zap         },
  { stage: "CREATING_ZIP",   label: "Creating ZIP",     icon: Archive     },
  { stage: "COMPLETED",      label: "Complete",         icon: CheckCircle },
];

const ACTIVE_STAGES = new Set<Stage>([
  "READING_PDF", "PARSING_ROWS", "FETCHING_IMAGES", "GENERATING_PDFS", "CREATING_ZIP",
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

function stageIndex(stage: Stage): number {
  if (stage === "REVIEW_GROUPS") {
    // Pause the timeline on "FETCHING_IMAGES" so previous steps remain highlighted as "done"
    return PIPELINE_STEPS.findIndex(s => s.stage === "FETCHING_IMAGES");
  }
  return PIPELINE_STEPS.findIndex(s => s.stage === stage);
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function Home() {
  const [dragActive,    setDragActive]    = useState(false);
  const [stage,         setStage]         = useState<Stage>("IDLE");
  const [errorMsg,      setErrorMsg]      = useState<string | null>(null);
  const [selectedFile,  setSelectedFile]  = useState<File | null>(null);
  const [stageDetail,   setStageDetail]   = useState<string>("");

  // Intermediate state
  const [rawRows,        setRawRows]        = useState<ParsedRow[]>([]);
  const [groups,         setGroups]         = useState<GroupedData[]>([]);
  const [quotationHeader,setQuotationHeader]= useState<QuotationHeader>({});
  const [processLog,     setProcessLog]     = useState<ProcessLog | null>(null);
  const [zipBlob,        setZipBlob]        = useState<Blob | null>(null);

  const isProcessing = ACTIVE_STAGES.has(stage) || stage === "REVIEW_GROUPS";

  // ── Validation ─────────────────────────────────────────────────────────────

  function validateFile(file: File): string | null {
    if (file.type !== "application/pdf") {
      return `Invalid file type "${file.type || "unknown"}". Please upload a PDF.`;
    }
    if (file.size > MAX_FILE_SIZE) {
      return `File exceeds the 25 MB limit (${(file.size / 1024 / 1024).toFixed(1)} MB).`;
    }
    return null;
  }

  // ── Phase 1: Parse PDF ─────────────────────────────────────────────────────

  const handleParseFile = useCallback(async (file: File) => {
    const validationError = validateFile(file);
    if (validationError) {
      setErrorMsg(validationError);
      setStage("ERROR");
      return;
    }

    setSelectedFile(file);
    setErrorMsg(null);
    setZipBlob(null);
    setProcessLog(null);
    resetImageState();

    try {
      setStage("READING_PDF");
      setStageDetail("");
      await new Promise(r => setTimeout(r, 50)); // allow re-render

      setStage("PARSING_ROWS");
      const { header, rows } = await parsePDF(file);

      if (rows.length === 0) {
        throw new Error("No valid product rows found in the PDF.");
      }

      const grouped = groupRows(rows);
      setRawRows(rows);
      setGroups(grouped);
      setQuotationHeader(header);
      setStageDetail(`Found ${rows.length} items across ${grouped.length} group${grouped.length !== 1 ? "s" : ""}.`);
      setStage("REVIEW_GROUPS");
    } catch (err: any) {
      console.error("[page] parse error:", err);
      setErrorMsg(err?.message ?? "Processing failed. Please try again.");
      setStage("ERROR");
    }
  }, []);

  // ── Phase 2: Generate PDFs ─────────────────────────────────────────────────

  const handleGeneratePdfs = useCallback(async () => {
    const startTime = performance.now();

    try {
      // Fetch images
      setStage("FETCHING_IMAGES");
      setStageDetail(`Looking up ${[...new Set(rawRows.map(r => r.rawDesignNumber))].length} unique products…`);
      await resolveImages(rawRows);

      const imgStats = getImageStats();
      setStageDetail(`Fetched ${imgStats.fetched} · Cached ${imgStats.cached} · Missing ${imgStats.missing}`);

      // Generate PDFs
      setStage("GENERATING_PDFS");
      const finalGroups = groupRows(rawRows); // re-group with imageUrls assigned

      const zip = new JSZip();
      
      const cleanName = (str: string) => str.replace(/[\\/:*?"<>|]/g, "").trim();
      const custName = cleanName(quotationHeader.customerName || "Customer");
      const qNo = cleanName(quotationHeader.quotationNo || "Quotation");
      const suffix = `${custName} ${qNo}`.trim();

      for (let i = 0; i < finalGroups.length; i++) {
        const g = finalGroups[i];
        setStageDetail(`Generating PDF ${i + 1} of ${finalGroups.length}: ${g.groupName}`);
        const pdfBlob = await generateGroupPdfBlob(g, quotationHeader);
        const groupNameClean = cleanName(g.groupName);
        zip.file(`${groupNameClean} - ${suffix}.pdf`, pdfBlob);
      }

      // ZIP
      setStage("CREATING_ZIP");
      setStageDetail("Compressing…");
      const content = await zip.generateAsync({ type: "blob" });

      const elapsed = (performance.now() - startTime) / 1000;

      setZipBlob(content);
      setGroups(finalGroups);
      setProcessLog({
        totalRows:      rawRows.length,
        groups:         finalGroups,
        imageStats:     imgStats,
        pdfsGenerated:  finalGroups.length,
        elapsedSeconds: elapsed,
      });
      setStage("COMPLETED");
    } catch (err: any) {
      console.error("[page] generate error:", err);
      setErrorMsg(err?.message ?? "Processing failed. Please try again.");
      setStage("ERROR");
    }
  }, [rawRows, quotationHeader]);

  // ── Event handlers ─────────────────────────────────────────────────────────

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);
      if (isProcessing) return;
      const file = e.dataTransfer.files?.[0];
      if (file) await handleParseFile(file);
    },
    [isProcessing, handleParseFile]
  );

  const handleFileInput = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (isProcessing) return;
      const file = e.target.files?.[0];
      if (file) await handleParseFile(file);
      e.target.value = ""; // allow re-selecting same file
    },
    [isProcessing, handleParseFile]
  );

  const handleDownload = () => {
    if (zipBlob) {
      const cleanName = (str: string) => str.replace(/[\\/:*?"<>|]/g, "").trim();
      const custName = cleanName(quotationHeader.customerName || "Customer");
      const qNo = cleanName(quotationHeader.quotationNo || "Quotation");
      saveAs(zipBlob, `${custName} ${qNo}.zip`);
    }
  };

  const handleReset = () => {
    setStage("IDLE");
    setErrorMsg(null);
    setZipBlob(null);
    setGroups([]);
    setRawRows([]);
    setProcessLog(null);
    setSelectedFile(null);
    setStageDetail("");
    setQuotationHeader({});
    resetImageState();
  };

  const handleRetry = () => {
    if (selectedFile) {
      handleParseFile(selectedFile);
    } else {
      handleReset();
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  const showDropzone = stage === "IDLE" || stage === "ERROR";

  const currentStepIdx = stageIndex(stage);

  return (
    <div className="ms-root">
      {/* ── Background orbs ── */}
      <div className="ms-orb ms-orb-1" aria-hidden />
      <div className="ms-orb ms-orb-2" aria-hidden />

      <div className="ms-container">

        {/* ── Header ── */}
        <header className="ms-header">
          <div className="ms-logo">
            <Layers className="ms-logo-icon" />
          </div>
          <h1 className="ms-title">Melting Splitter</h1>
          <p className="ms-subtitle">
            Split jewellery quotation PDFs by&nbsp;KT&nbsp;+&nbsp;Color
          </p>
        </header>

        {/* ── Upload Zone ── */}
        {showDropzone && (
          <div
            id="dropzone"
            className={`ms-dropzone ${dragActive ? "ms-dropzone--active" : ""} ${
              isProcessing ? "ms-dropzone--disabled" : ""
            }`}
            onDragOver={e => { e.preventDefault(); if (!isProcessing) setDragActive(true); }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
            role="region"
            aria-label="PDF upload area"
          >
            <Upload className="ms-dropzone-icon" />
            <p className="ms-dropzone-primary">
              {selectedFile && stage === "ERROR"
                ? selectedFile.name
                : "Drag & drop your PDF here"}
            </p>
            <p className="ms-dropzone-secondary">or</p>
            <label className="ms-btn ms-btn--primary" htmlFor="pdf-input">
              Choose PDF
              <input
                id="pdf-input"
                type="file"
                accept="application/pdf"
                className="sr-only"
                onChange={handleFileInput}
                disabled={isProcessing}
              />
            </label>
            <p className="ms-dropzone-hint">PDF only · Max 25 MB</p>
          </div>
        )}

        {/* ── Pipeline progress ── */}
        {stage !== "IDLE" && stage !== "ERROR" && (
          <div className="ms-card">

            {/* Progress steps */}
            <div className="ms-steps">
              {PIPELINE_STEPS.map((step, idx) => {
                const done    = idx < currentStepIdx;
                const active  = idx === currentStepIdx;
                const pending = idx > currentStepIdx;
                const Icon    = step.icon;
                return (
                  <div
                    key={step.stage}
                    className={`ms-step ${done ? "ms-step--done" : ""} ${active ? "ms-step--active" : ""} ${pending ? "ms-step--pending" : ""}`}
                  >
                    <div className="ms-step-icon">
                      {done ? (
                        <CheckCircle size={14} />
                      ) : active && stage !== "REVIEW_GROUPS" && stage !== "COMPLETED" ? (
                        <Loader2 size={14} className="ms-spin" />
                      ) : (
                        <Icon size={14} />
                      )}
                    </div>
                    <span className="ms-step-label">{step.label}</span>
                  </div>
                );
              })}
            </div>

            {/* Stage detail / context */}
            {stageDetail && stage !== "REVIEW_GROUPS" && stage !== "COMPLETED" && (
              <p className="ms-stage-detail">{stageDetail}</p>
            )}

            {/* ── REVIEW_GROUPS ── */}
            {stage === "REVIEW_GROUPS" && (
              <div className="ms-review">
                <p className="ms-review-summary">{stageDetail}</p>

                <div className="ms-group-list" role="list" aria-label="Detected groups">
                  {groups.map(g => (
                    <div key={g.groupName} className="ms-group-row" role="listitem">
                      <span className="ms-group-name">{g.groupName}</span>
                      <span className="ms-group-meta">
                        {g.items.length} item{g.items.length !== 1 ? "s" : ""}
                        &nbsp;·&nbsp;{g.totalQty} qty
                      </span>
                    </div>
                  ))}
                </div>

                <div className="ms-review-actions">
                  <button
                    id="btn-generate"
                    className="ms-btn ms-btn--primary ms-btn--large"
                    onClick={handleGeneratePdfs}
                  >
                    <Zap size={18} /> Generate PDFs
                  </button>
                  <button
                    id="btn-cancel"
                    className="ms-btn ms-btn--ghost"
                    onClick={handleReset}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* ── COMPLETED ── */}
            {stage === "COMPLETED" && processLog && (
              <div className="ms-complete">
                {/* Processing log */}
                <div className="ms-log" role="region" aria-label="Processing summary">
                  <div className="ms-log-row">
                    <span className="ms-log-label">PDF rows parsed</span>
                    <span className="ms-log-value">{processLog.totalRows}</span>
                  </div>
                  <div className="ms-log-divider" />

                  <p className="ms-log-section">Groups</p>
                  {processLog.groups.map(g => (
                    <div key={g.groupName} className="ms-log-row">
                      <span className="ms-log-label ms-log-label--indent">{g.groupName}</span>
                      <span className="ms-log-value">{g.items.length} items</span>
                    </div>
                  ))}
                  <div className="ms-log-divider" />



                  <div className="ms-log-row">
                    <span className="ms-log-label">PDFs generated</span>
                    <span className="ms-log-value">{processLog.pdfsGenerated}</span>
                  </div>
                </div>

                <div className="ms-complete-actions">
                  <button
                    id="btn-download"
                    className="ms-btn ms-btn--success ms-btn--large"
                    onClick={handleDownload}
                  >
                    <FileDown size={18} /> Download ZIP
                  </button>
                  <button
                    id="btn-start-over"
                    className="ms-btn ms-btn--ghost"
                    onClick={handleReset}
                  >
                    Start Over
                  </button>
                </div>

                <div className="ms-complete-hero">
                  <CheckCircle className="ms-complete-icon" />
                  <h2 className="ms-complete-title">Done!</h2>
                  <p className="ms-complete-time">
                    Completed in {processLog.elapsedSeconds.toFixed(1)} s
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Error card ── */}
        {stage === "ERROR" && (
          <div className="ms-card ms-card--error" role="alert">
            <AlertCircle className="ms-error-icon" />
            <h3 className="ms-error-title">Processing Failed</h3>
            <p className="ms-error-msg">{errorMsg}</p>
            <div className="ms-error-actions">
              {selectedFile && (
                <button
                  id="btn-retry"
                  className="ms-btn ms-btn--primary"
                  onClick={handleRetry}
                >
                  <RefreshCw size={16} /> Retry
                </button>
              )}
              <button
                id="btn-try-again"
                className="ms-btn ms-btn--ghost"
                onClick={handleReset}
              >
                Choose different file
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}



