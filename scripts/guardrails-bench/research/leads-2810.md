# Leads checked 28/10, ranked by how soon we can score

Every lead the research run and solenoid-security's PUBLIC_SOURCES.md named. Files are in `~/Development/.guardrail-data/new-2810/leads/`. Nothing is built or scored yet.

## Pages

| # | Set | Licence | Size | Format | Real or generated | Labels | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | In-Page Prompt Injection in the Wild (SoheilKhodayari/in_page_prompt_injection_pub, CCS 2026) | CC BY 4.0 data, AGPL code | 31,206 rows: 15,387 attacks, 15,753 benign, 66 unsure | about 620-character slice of the crawl record around the match; no URLs, so pages cannot be fetched again | real (Common Crawl, Censys, Shodan) | checked by hand (`fp`) | Use. This is the "IPI in the Wild" study we listed as not public, now released as slices. Body slices only: 7,887 attacks are HTTP headers, a channel the page model does not read. English or unknown body rows: 6,563 attacks (764 distinct prompts, 7,246 distinct slices, 2,013 sites) and 14,671 benign (2,480 distinct slices, 748 sites). Exfiltration is 13 rows; most attacks are garbage output, bot checks and general instruction changes. Benign rows include leaked prompt templates ("ignore all previous instructions, you are an expert copywriter"): a label-intent caveat column, sample 20 before trusting. |
| 2 | WARP taskgen IPI 50 (HF anonymous-dataset-submission-warp) | none stated | 50 tasks × 6 models, 2.26 GB | accessibility tree per step, HAR, screenshots | generated attacks in real WebArena GitLab and Reddit pages | task results | Use for scoring only (no licence). Steps before and after the injection give clean and attacked pages from the same app. |
| 3 | PyPI README PageBench (Kaggle rodrigosfaria) | Apache-2.0 | 217 real READMEs + 60 attacked (half pt-BR) | rebuild text from PyPI METADATA | real benign, generated attacks | by construction | Use; English attacked rows only. |
| 4 | LongPIBench (HF RainWatcher) | MIT | 100 long papers, emails, code | text | real | clean | Hard ordinary set. |
| 5 | JED aicomp-sdk wheel / competitionscratch (same corpus) | MIT | 19,679 pages, 351 templates | text | generated | by construction | Low variety; score a deduplicated slice. |

## Tool results and tool errors

| # | Set | Licence | Size | Verdict |
|---|---|---|---|---|
| 6 | mcp-fault-bench (brvtl) | Apache-2.0 | 808 distinct clean tool results, 74 distinct error strings, no attacks | Use for the tool-error false-alarm row. The errors give orders ("Do not retry get_price; use fallback tool get_price_v2"), so they are hard benign. |
| 7 | AgentInjectionBench (ppradyoth) | Apache-2.0 | 142 attacks, 40 benign; tool output, MCP, API, RAG, file | Use. Hand-written tool results. |
| 8 | AgentSec-Bench (Zenodo 23734797) | MIT | 240 tool tasks with payload slots | Use; build attacked and clean copies. |
| 9 | AgentDyn (SaFo-Lab) | MIT | 47,723 runs; 6,314 without an attack | Clean tool results from the new dailylife, github and shopping suites are new. Attack text is the AgentDojo `<INFORMATION>` template we hold. |
| 10 | Nemotron-RL-Agentic-IPI-v1 (nvidia; Kaggle yashdogra is the same) | CC BY 4.0 | 1,272 | Use; attack sits inside environment JSON. |
| 11 | INFUSE (judydnguyen) | see repo | 40 workspaces, 58 templates | Templates only; trajectories not public. |
| 12 | SIEM logs (Kaggle rounak8906) | CC BY-SA | 2 million lines, 7 templates | Low variety; deduplicated slice. |
| 13 | sentinelden agent-injection-bench | see repo | 24 | Small. |
| 14 | GraySwanAI ipi_arena_os | see repo | tool, coding, browser JSON | Check overlap with the arena rows we hold. |
| 15 | sureheremarv ipi_arena_attacks | see card | 95 | Overlap with held arena rows not checked yet. |

## Tool and skill definitions (a different channel)

| # | Set | Licence | Size | Verdict |
|---|---|---|---|---|
| 16 | HISTOR MCP tool definitions (Kaggle alexar76) | CC BY 4.0 | 57,846 real tool sets (toolsets.jsonl, 1.9 GB); 636 servers with a block-tier pattern match | Real tool descriptions at scale. Only matters if Theorem scans tool definitions. |
| 17 | skill-inject (aisa-group) | MIT | 36 obvious + 48 contextual injections into skill files | Skill-file channel. |

## Small sets

IPIBench 100; isotope 26; raucle 15 indirect + 40 benign; mukunda1729 74 (Kaggle mukundakatta is the same 74); agentrank 6 goals × 6 techniques × 3 carriers; hrittijab AgentSecBench; samyshyaka 9 scenarios; wify777 60 tool-directed payloads (no licence); iamabhishekpanda 2,000 short synthetic; financial RAG 10,000 short template rows.

## Skipped

| Set | Why |
|---|---|
| PIDS (ShirePyDev) | User-typed prompts; data is non-commercial (Alpaca, qualifire); 664 of the 1,472 hard-benign rows are LMSYS with text removed. |
| RepoGuardBench | Issues are clean; attacks are added at run time by code. |
| indirect-pia-detection (LukeChen) | Training contexts for their own detector, SQuAD and TriviaQA with instructions put in; like SEP, which we hold. |
| SPIDER OOD, IPI-proxy | Contain Tensor Trust. |
| AgentExploitDB, RAGProbe, ArkhAngel, Saluteface, zachz, edithngalame, samliumay, JokeMaker, Zenodo 20057632, jackyk02, emgena teasers | One payload, user vector, direct, multilingual, wrong task, 11 KB, embeddings only, or teasers. |
| luthfimuthathohirin | Metadata columns only, no text. |
| beatsprom stateless MCP | Synthetic MCP training data, no attacks. |
| muhammadahmerkhan, basitalisandhu, sebastiannestler | Incident lists, not text an agent reads. |
| DominicDamire, OctaviusLeo, D-Carrillo, mithil2k2000, mixshield | Results or scores only. |
| jagadish | deepset only. |
| palisade, intact, A1LinLin1, mcp-bom | No data. |
| Arthur-AI | Not found. |
| HTTP Archive | Needs paid BigQuery. FineWeb (ODC-By) stays the ordinary-page source. |
