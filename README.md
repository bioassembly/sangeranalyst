<h1 align="center"><img src="assets/favicon.ico" width="32" height="32"></img> SangerAnalyst — A Free, Web-Based Sanger Sequencing Analysis Tool</h1>

<p align="center">
  <img src="https://img.shields.io/badge/100%25-Free-FFD60A?style=for-the-badge" />
</p>

---

SangerAnalyst provides a lightning-fast and straightforward way to process Sanger chromatograms within seconds—no installation required and 100% free.

The application performs automated quality trimming, forward–reverse read alignment, consensus generation guided by per-base Phred scores, and anchor-based primer trimming. It also produces a clear conflict report, making mismatches, gaps, and low-confidence positions immediately visible.

This streamlined workflow enables users to obtain an accurate consensus sequence while saving significant time and avoiding the usual manual analysis headaches.

👉 **Support new features on the web:**  
https://bioassembly.github.io/sangeranalyst

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

These files are available in the **`demo/`** directory of this repository.

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
Defaults work well for most datasets.  
- **Mott Trim Cutoff** — Controls how aggressively low-quality regions are removed before alignment.  
- **Minimum Base Phred Quality** — Bases below this threshold are replaced with **`N`**.

### **4. Run `Analyze`**  
The backend processes each request in ~0.4 seconds, uploaded data is deleted immediately after processing.

### **5. Inspect Results**
You will receive 2 outputs (3 if primer included):

#### 🔹 High-Confidence Consensus  
Derived from the overlapping region of forward–reverse alignment. All conflicts and gaps are reported, and only the higher-quality base is selected.

#### 🔹 Full Merge  
A full-span merge of both chromatogram alignments (not recommended for conclusions). Useful for mapping and reference visualization.

#### 🔹 Primer-Trimmed Consensus  
Primer regions removed from the full merge:  
`---Primer_F | -----High Confidence Consensus----- | Primer_R---`  
This provides the longest methodologically reliable sequence, though meaning it's outside High Confidence Consensus region originate from single-read data, which may still have some mismatch or gap compared to the real life biologic DNA sequence.

---

## 🛠️ Roadmap (To-Do Next)

- 📱 **Mobile UI improvements** — better layout, larger buttons, smoother long-sequence handling.  
- 📈 **Chromatogram viewer** — interactive peak traces for conflict inspection.  
- 🧬 **Gene annotations** — automatic ORF detection.  
- 🧭 **Reference mapping** — align consensus to a reference and highlight differences.  
- 📦 **Batch processing** — analyze multiple samples at once.

---

## 📚 Acknowledgement

This project uses **BioPython** for AB1 parsing and core sequence utilities. Its modules provide reliable foundational functions required for Sanger data processing.

---

<p align="center">
  <sub>Made for easy, fast, and accurate Sanger sequencing analysis.</sub>
</p>
