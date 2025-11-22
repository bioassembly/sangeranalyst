# SangerAnalyst – A Free, Web-Based Sanger Sequencing Processor

SangerAnalyst provides a lightning-fast and straightforward way to process Sanger chromatograms within seconds—no installation required and 100% free.

The application performs automated quality trimming, forward–reverse read alignment, consensus generation guided by per-base Phred scores, and anchor-based primer trimming. It also produces a clear conflict report, making mismatches, gaps, and low-confidence positions immediately visible.

This streamlined workflow enables users to obtain an accurate consensus sequence while saving significant time and avoiding the usual manual analysis headaches.

Support new features on the web! 
https://bioassembly.github.io/sangeranalyst

## **Demo Dataset**

A publicly available control dataset is provided for users to test the tool without uploading their own files.

### Source:
CRISPR-Cas9 edited cane toad tyrosinase gene — control samples (public domain data)
DOI: https://doi.org/10.1101/2025.05.15.654396

### Included demo files:
- fwd_control.ab1
- rev_control.ab1
- primer_fwd.fasta
- primer_rev.fasta

These files are available in the `demo/` directory of this repository.

## **Usage Guide**

**1. Open the Webpage**
  Visit https://bioassembly.github.io/sangeranalyst
  
**2. Upload Input Files**
  Prepare the following files
    - Forward read chromatogram (.ab1)
    - Reverse read chromatogram (.ab1)
    - Primers (Optional, and you can type them too)
    
**3. Adjust Processing Settings (Optional)**
  Default works well for most dataset, but you may fine-tune them:
    - Mott Trim Cutoff: Controls how aggresively low-quality regions are removed before alignment. A lower value retains less bases and can improve alignment accuracy, but setting it too low may also remove good bases. Adjust as needed for your dataset.  
    - Min Base Phred Quality: Bases with Phred Quality below this value will be replaced as `N`.
    
**4. Run `Analyze`**
  Your files will be sent to the backend server for processing. Each request typically completes in ~0.4 seconds, and all uploaded data will be deleted immediately after the processing is completed.
  
  **5. Result Inspection**
  
