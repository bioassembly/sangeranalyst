<h1 align="center"><img src="public/assets/favicon.ico" width="32" height="32" /> SangerAnalyst — A Free, Web-Based Sanger Sequencing Analysis Tool</h1>

<p align="center">
  <img src="https://img.shields.io/badge/100%25-Free-FFD60A?style=for-the-badge" />
</p>

---

SangerAnalyst provides a lightning-fast and straightforward way to process Sanger chromatograms within seconds—no installation required and 100% free.

The application performs automated quality trimming, forward–reverse read alignment, consensus generation guided by per-base Phred scores, and anchor-based primer trimming. It also produces a clear conflict report, making mismatches, gaps, and low-confidence positions immediately visible.

This streamlined workflow enables users to obtain an accurate consensus sequence while saving significant time and avoiding the usual manual analysis headaches.

SangerAnalyst is available as a **browser tool**. Its analysis API is private; local installation and direct API use are not offered.

👉 **Support new features on the web:**  
https://bioassembly.github.io/sangeranalyst

---

## ✨ Features

- **Input chromatograms** — forward/reverse traces appear immediately on file selection or **Try demo data**, with zoom, pan, quality shading and secondary-peak markers. Typical-peak scaling keeps neighboring peaks readable; **Fit all peaks** reveals full heights. Select a marker or choose a peak to inspect its bases and original-signal ratio. Traces work without the analysis API. Secondary-peak markers appear after Analyze and refilter locally when trimming or threshold settings change.
- **Final read alignment** — each result tab brings together its final FASTA, alignment, and exports, with mismatch, gap, mixed-base, and `N` highlighting. Select a conflict to inspect the corresponding chromatogram bases.
- **Read-coverage maps** — forward and reverse reads share a full-merge coordinate axis. Red boundaries show the region used for consensus, while shading marks excluded regions. Coloured markers identify mismatches, mixed bases, and `NNNN`; white gaps appear only on the affected read.
- **Primer-binding visualization** — primer bars sit beside their corresponding template reads, with a colour legend and gapped binding alignments. The primer-trimmed read alignment shows only the retained sequence.
- **Quality-weighted consensus** — Mott trimming, automatic orientation detection, statistically validated overlap, PolyPhred-style heterozygote calling (IUPAC codes), and conflict/secondary-peak reports embedded in each output.
- **Smart upload & primer handling** — drag & drop `.ab1` auto-pairing (`_F`/`_R`, `27F`/`1492R`, etc.), 1-click `⇄` F/R swap, plus FASTA (`.fasta`/`.fa`/`.fna`/`.txt`) or pasted primer sequences (IUPAC accepted, min 10 bases).
- **Clean FASTA & Full Report exports** — High-Confidence Consensus, Full Merge, and conditional Primer-Trimmed Consensus each provide **Copy FASTA** / **Download `.fasta`** (strict FASTA for BLAST/SnapGene/Biopython) alongside **Copy Report** / **Download Report (`.txt`)**; IUPAC ambiguity bases are highlighted strictly on sequence lines.
- **Demo dataset** — **Try demo data** button loads the bundled control files instantly.
- **Remembered settings** — Mott cutoff, min Phred, and secondary-peak threshold persist in your browser (localStorage).
- **Mobile-friendly** — responsive layout, FAQ accordion, tooltips, and inline validation (5 MB per `.ab1`, ABIF signature check).

---

## 📂 Demo Dataset

A publicly available control dataset is provided for users to test the tool without uploading their own files.

### **Source**
CRISPR-Cas9 edited cane toad *tyrosinase* gene — control samples (public domain data)  
DOI: https://doi.org/10.1101/2025.05.15.654396

### **Included demo files**
- `fwd_control.ab1`  
- `rev_control.ab1`  
- `primer_fwd.fasta`  
- `primer_rev.fasta`  

These files are available in the **`public/demo/`** directory of this repository (also loadable directly in the app via the **Try demo data** button).

---

## 🚀 Usage Guide

### **1. Open the Webpage**  
Visit **https://bioassembly.github.io/sangeranalyst**

### **2. Upload Input Files**
Prepare the following files:  
- Forward read chromatogram (`.ab1`)  
- Reverse read chromatogram (`.ab1`)  
- Primers (optional; can be uploaded or typed)

### **3. Adjust Processing Settings (Optional)**  
Defaults work well for most datasets (Mott `0.1`, min Phred `20`, secondary peak `33%`).  
- **Mott Trim Cutoff** — Controls how aggressively low-quality regions are removed before alignment.  
- **Minimum Base Phred Quality** — Controls which read calls support the consensus; positions without sufficient quality support become **`N`**.
- **Secondary peak threshold (%)** — Controls the sensitivity for detecting mixed bases (heterozygotes).

  <img src="public/assets/secondary_peak-min.png" width="96" height="96"/>
### **4. Run `Analyze`**  
The backend processes each request in ~0.4 seconds, uploaded data is deleted immediately after processing.

### **5. Inspect Results**
Switch between the result tabs to review each final FASTA, coverage map, and read alignment. Highlighted conflicts take you to the corresponding chromatogram bases. Copy or download the sequence or complete text report, and review any warnings before using the result.

You will receive 2 outputs (3 if primer included):

#### 🔹 High-Confidence Consensus  
Derived from the overlapping region of forward–reverse alignment (statistically validated). Conflicts and gaps are reported: sequencing errors are corrected from the higher-quality strand, and heterozygous positions confirmed by secondary peaks are kept as IUPAC ambiguity codes.

#### 🔹 Full Merge  
A full-span merge of both chromatogram alignments. This is where longer amplicons shine: on a ~1,500 bp template, ~900 bp forward and reverse reads share only ~300 bp of overlap — the Full Merge reconstructs the entire 1,500 bp span, while bases outside the overlap originate from a single read (keep that caveat in mind for conclusions). For short amplicons it is mainly useful for mapping and reference visualization.

#### 🔹 Primer-Trimmed Consensus  
Primer regions removed from the full merge:  
`---Primer_F | -----High Confidence Consensus----- | Primer_R---`  
The binding map shows where each primer aligns on the full merge. Gapped primer alignments show the match in detail, and the read alignment below shows only the sequence retained after trimming. Regions outside the validated overlap still rely on a single read; primer trimming does not make them high confidence.

---

## 🔍 Reviewing and Exporting Results

Results are organized into **High confidence**, **Full merge**, and **Primer trimmed** tabs. Each tab keeps its sequence, alignment, and export buttons together. The coverage maps show the full assembly context and which region contributes to the selected consensus.

The shared **Secondary-peak** table follows the selected tab's consensus positions. Selecting a result opens the original `.ab1` bases in the chromatogram, with a control to return to the results. Peak screening runs on the server after **Analyze**; changing the Mott cutoff or secondary-peak threshold filters the cached markers in the browser. Trimmed regions are excluded.

Secondary peaks do not automatically produce mixed-base consensus calls. IUPAC ambiguity codes are used when both reads meet the quality threshold and disagree, and a secondary peak supports the same base pair. The demo can therefore show a secondary peak without an IUPAC ambiguity code in its consensus.

Use **Copy FASTA** or **Download .fasta** for a clean sequence, or export the complete text report. **NCBI BLASTn** copies the selected FASTA and opens NCBI for pasting. Editing reads, primers, or settings disables exports until you run **Analyze** again.

Further interface proposals are recorded in the [improvement plan](docs/UI_IMPROVEMENT_PLAN.md).

---

## 🛠️ Roadmap (To-Do Next)

- 🧭 **Reference mapping** — align consensus to a reference and highlight differences.  
- 📦 **Batch processing** — analyze multiple samples at once.
- 📈 **Viewer enhancements** — consistent orientation and quality preview across analysis routes.

---

## 📚 Acknowledgement

This project uses **BioPython** for AB1 parsing and core sequence utilities. Its modules provide reliable foundational functions required for Sanger data processing.

---

<p align="center">
  <sub>Made for easy, fast, and accurate Sanger sequencing analysis.</sub>
</p>
