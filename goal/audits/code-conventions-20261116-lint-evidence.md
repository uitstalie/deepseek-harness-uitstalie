# Lint 明细（只读）

命令：`pnpm exec oxlint --config .oxlintrc.json --format=github packages/uitstalie packages/jira packages/superagent packages/interaction/tool-policy`。共 563 项；规则名即 gate 失败依据。

## packages/jira/jira-agent/src/command.test.ts

| 行:列 | 规则 |
|---|---|
| 48:9 | no-unnecessary-condition |
| 274:27 | require-await |
| 278:98 | require-await |

## packages/jira/jira-agent/src/compaction-seam.test.ts

| 行:列 | 规则 |
|---|---|
| 34:3 | require-await |
| 43:3 | require-await |
| 79:29 | no-unsafe-return |
| 85:7 | require-await |
| 86:7 | require-await |
| 87:7 | require-await |
| 88:7 | require-await |
| 95:21 | no-deprecated |
| 104:7 | require-await |
| 105:7 | require-await |
| 106:7 | require-await |
| 107:7 | require-await |
| 110:29 | no-unsafe-return |
| 124:7 | require-await |
| 125:7 | require-await |
| 126:7 | require-await |
| 127:7 | require-await |

## packages/jira/jira-agent/src/dispatch-ledger.test.ts

| 行:列 | 规则 |
|---|---|
| 43:18 | no-unnecessary-condition |
| 44:18 | no-unnecessary-condition |
| 45:18 | no-unnecessary-condition |
| 46:18 | no-unnecessary-condition |
| 47:18 | no-unnecessary-condition |
| 47:18 | no-unnecessary-condition |
| 48:18 | no-unnecessary-condition |
| 48:18 | no-unnecessary-condition |
| 80:18 | no-unnecessary-condition |
| 81:18 | no-unnecessary-condition |
| 82:18 | no-unnecessary-condition |

## packages/jira/jira-agent/src/dispatch-reports.test.ts

| 行:列 | 规则 |
|---|---|
| 56:18 | no-unnecessary-condition |
| 77:18 | no-unnecessary-condition |
| 78:18 | no-unnecessary-condition |
| 97:18 | no-unnecessary-condition |
| 98:18 | no-unnecessary-condition |
| 99:18 | no-unnecessary-condition |
| 100:18 | no-unnecessary-condition |
| 101:18 | no-unnecessary-condition |
| 107:18 | no-unnecessary-condition |
| 108:18 | no-unnecessary-condition |
| 109:18 | no-unnecessary-condition |
| 110:18 | no-unnecessary-condition |
| 138:18 | no-unnecessary-condition |
| 146:18 | no-unnecessary-condition |
| 147:18 | no-unnecessary-condition |
| 148:18 | no-unnecessary-condition |
| 149:18 | no-unnecessary-condition |
| 150:18 | no-unnecessary-condition |
| 151:18 | no-unnecessary-condition |
| 173:18 | no-unnecessary-condition |
| 174:18 | no-unnecessary-condition |
| 186:18 | no-unnecessary-condition |
| 199:18 | no-unnecessary-condition |

## packages/jira/jira-agent/src/index.test.ts

| 行:列 | 规则 |
|---|---|
| 769:13 | await-thenable |
| 769:13 | no-confusing-void-expression |
| 896:12 | no-unnecessary-condition |

## packages/jira/jira-agent/src/permission-integration.test.ts

| 行:列 | 规则 |
|---|---|
| 47:94 | require-await |
| 48:21 | require-await |
| 51:19 | require-await |
| 52:21 | require-await |
| 53:21 | require-await |
| 54:27 | require-await |
| 56:50 | no-unsafe-return |
| 105:39 | no-deprecated |
| 142:41 | no-deprecated |

## packages/jira/jira-agent/src/role.test.ts

| 行:列 | 规则 |
|---|---|
| 10:1 | no-floating-promises |

## packages/jira/jira-agent/src/schema.test.ts

| 行:列 | 规则 |
|---|---|
| 62:9 | no-unnecessary-condition |
| 79:9 | no-unnecessary-condition |
| 92:10 | no-unnecessary-condition |
| 97:9 | no-unnecessary-condition |
| 175:18 | no-unnecessary-condition |
| 176:29 | no-unnecessary-condition |
| 177:29 | no-unnecessary-condition |
| 178:23 | no-unnecessary-condition |

## packages/jira/jira-agent/src/skills.test.ts

| 行:列 | 规则 |
|---|---|
| 46:9 | no-unnecessary-condition |
| 50:10 | no-unnecessary-condition |

## packages/jira/jira-agent/src/superagent.test.ts

| 行:列 | 规则 |
|---|---|
| 328:3 | require-await |
| 344:23 | require-await |
| 345:7 | require-await |
| 336:3 | require-await |
| 351:3 | require-await |
| 477:43 | no-unnecessary-condition |
| 483:31 | require-await |
| 544:3 | require-await |
| 563:25 | no-unnecessary-type-conversion |
| 561:3 | require-await |
| 570:3 | require-await |
| 571:3 | require-await |
| 572:3 | require-await |
| 587:7 | require-await |
| 592:7 | require-await |
| 596:48 | no-unnecessary-type-conversion |
| 595:7 | require-await |
| 599:7 | require-await |
| 600:7 | require-await |
| 606:96 | require-await |
| 610:88 | require-await |
| 609:7 | require-await |
| 612:7 | require-await |
| 647:18 | no-unnecessary-condition |
| 687:40 | require-await |
| 700:18 | no-unnecessary-condition |
| 702:90 | no-unnecessary-condition |
| 702:125 | no-unnecessary-condition |
| 739:33 | require-await |
| 777:18 | no-unnecessary-condition |
| 777:18 | no-unnecessary-condition |
| 778:18 | no-unnecessary-condition |
| 778:18 | no-unnecessary-condition |
| 797:7 | require-await |
| 802:7 | require-await |
| 808:7 | require-await |
| 809:7 | require-await |
| 812:85 | require-await |
| 815:7 | require-await |
| 816:131 | require-await |
| 816:7 | require-await |
| 820:7 | require-await |
| 826:7 | require-await |
| 846:35 | no-unnecessary-type-assertion |
| 846:101 | no-unnecessary-type-assertion |
| 915:84 | require-await |
| 917:136 | require-await |
| 917:7 | require-await |
| 923:7 | require-await |
| 924:7 | require-await |
| 925:7 | require-await |
| 926:7 | require-await |
| 1041:35 | require-await |
| 1069:41 | require-await |
| 1088:9 | require-await |
| 1089:9 | require-await |
| 1090:9 | require-await |
| 1091:9 | require-await |
| 1135:18 | no-unnecessary-condition |
| 1135:18 | no-unnecessary-condition |
| 1177:153 | require-await |
| 1202:21 | require-await |
| 1221:69 | no-unnecessary-condition |
| 1352:7 | require-await |
| 1353:7 | require-await |
| 1356:7 | require-await |
| 1488:18 | no-unnecessary-condition |
| 1495:33 | require-await |
| 1509:18 | no-unnecessary-condition |
| 1512:40 | require-await |
| 1516:71 | no-unnecessary-condition |
| 1552:18 | no-unnecessary-condition |
| 1552:18 | no-unnecessary-condition |
| 1553:18 | no-unnecessary-condition |
| 1553:18 | no-unnecessary-condition |
| 1612:18 | no-unnecessary-condition |
| 1613:18 | no-unnecessary-condition |
| 1617:18 | no-unnecessary-condition |
| 1623:33 | require-await |
| 1637:25 | no-base-to-string |
| 2123:94 | require-await |
| 2126:86 | require-await |
| 2125:5 | require-await |
| 2146:7 | require-await |
| 2147:7 | require-await |
| 2148:7 | require-await |
| 2150:34 | no-unnecessary-type-conversion |
| 2179:18 | no-unnecessary-condition |
| 2180:15 | no-unnecessary-condition |
| 2180:74 | no-unnecessary-condition |
| 2185:105 | no-unnecessary-condition |
| 2205:7 | require-await |
| 2206:7 | require-await |
| 2207:7 | require-await |
| 2208:75 | no-unnecessary-type-conversion |
| 2208:7 | require-await |
| 2231:7 | require-await |
| 2232:80 | no-unnecessary-type-conversion |
| 2232:7 | require-await |
| 2233:7 | require-await |
| 2234:7 | require-await |
| 2237:101 | require-await |
| 2239:131 | require-await |
| 2239:7 | require-await |
| 2259:31 | require-await |
| 2272:7 | require-await |
| 2273:7 | require-await |
| 2274:7 | require-await |
| 2275:7 | require-await |
| 2278:92 | require-await |
| 2280:131 | require-await |
| 2280:7 | require-await |
| 2297:7 | require-await |
| 2298:7 | require-await |
| 2317:7 | require-await |
| 2323:7 | require-await |
| 2350:7 | require-await |
| 2351:7 | require-await |
| 2352:7 | require-await |
| 2353:7 | require-await |
| 2356:98 | require-await |
| 2358:131 | require-await |
| 2358:7 | require-await |
| 2362:7 | require-await |
| 2363:7 | require-await |
| 2492:22 | no-unnecessary-condition |
| 2493:18 | no-unnecessary-condition |
| 2494:22 | no-unnecessary-condition |
| 2604:156 | require-await |
| 2637:18 | no-unnecessary-condition |
| 2637:18 | no-unnecessary-condition |
| 2638:18 | no-unnecessary-condition |
| 2638:18 | no-unnecessary-condition |
| 2742:18 | no-unnecessary-condition |
| 2757:94 | require-await |
| 2760:86 | require-await |
| 2759:5 | require-await |
| 2782:18 | no-unnecessary-condition |
| 2790:46 | require-await |
| 2825:27 | require-await |
| 2843:46 | require-await |
| 2879:46 | require-await |
| 2947:58 | require-await |
| 2982:16 | no-unnecessary-condition |
| 2983:18 | no-unnecessary-condition |
| 2984:18 | no-unnecessary-condition |
| 3085:7 | require-await |
| 3090:7 | require-await |
| 3113:18 | no-unnecessary-condition |
| 3139:7 | require-await |
| 3143:7 | require-await |
| 3144:7 | require-await |
| 3184:20 | no-unnecessary-condition |
| 3210:26 | no-unnecessary-condition |
| 3220:20 | no-unnecessary-condition |
| 3221:24 | no-unnecessary-condition |
| 3282:18 | no-unnecessary-condition |
| 3325:24 | no-unnecessary-condition |
| 3503:3 | require-await |
| 3509:3 | require-await |
| 3513:3 | require-await |
| 3666:20 | no-unnecessary-condition |
| 3667:20 | no-unnecessary-condition |
| 3761:47 | require-await |
| 3783:47 | require-await |
| 3957:10 | no-unnecessary-condition |
| 3988:12 | no-unnecessary-condition |
| 4013:12 | no-unnecessary-condition |
| 4040:20 | no-unnecessary-condition |
| 4089:7 | require-await |
| 4090:7 | require-await |
| 4121:39 | require-await |

## packages/jira/jira-agent/src/superagent.ts

| 行:列 | 规则 |
|---|---|
| 2441:20 | no-unnecessary-condition |
| 2699:7 | no-unnecessary-condition |
| 3061:13 | no-unnecessary-condition |
| 3191:18 | return-await |
| 3196:18 | return-await |
| 3202:18 | return-await |
| 3210:20 | return-await |
| 3219:18 | return-await |
| 3225:22 | no-unnecessary-boolean-literal-compare |
| 3232:18 | return-await |
| 3237:18 | return-await |
| 3242:15 | no-unnecessary-condition |
| 3251:18 | return-await |
| 3354:13 | no-unnecessary-condition |
| 4578:25 | no-unnecessary-condition |
| 5356:15 | no-unnecessary-condition |
| 5359:13 | no-unnecessary-condition |
| 5361:33 | no-unnecessary-condition |
| 5438:3 | no-unnecessary-condition |
| 5868:15 | no-unnecessary-condition |

## packages/jira/jira-cli/src/main.test.ts

| 行:列 | 规则 |
|---|---|
| 302:32 | no-unnecessary-condition |

## packages/jira/jira-core/src/args.test.ts

| 行:列 | 规则 |
|---|---|
| 21:8 | no-unnecessary-condition |
| 41:10 | no-unnecessary-condition |
| 65:10 | no-unnecessary-condition |
| 72:10 | no-unnecessary-condition |
| 82:12 | no-unnecessary-condition |
| 91:10 | no-unnecessary-condition |
| 105:10 | no-unnecessary-condition |
| 111:10 | no-unnecessary-condition |
| 117:10 | no-unnecessary-condition |

## packages/jira/jira-core/src/batch.test.ts

| 行:列 | 规则 |
|---|---|
| 22:8 | no-unnecessary-condition |
| 55:9 | no-unnecessary-condition |
| 69:10 | no-unnecessary-condition |
| 77:9 | no-unnecessary-condition |

## packages/jira/jira-core/src/codec.test.ts

| 行:列 | 规则 |
|---|---|
| 37:8 | no-unnecessary-condition |
| 115:10 | no-unnecessary-condition |
| 131:10 | no-unnecessary-condition |
| 140:10 | no-unnecessary-condition |
| 162:10 | no-unnecessary-condition |
| 168:10 | no-unnecessary-condition |
| 174:10 | no-unnecessary-condition |

## packages/jira/jira-core/src/comments.test.ts

| 行:列 | 规则 |
|---|---|
| 19:8 | no-unnecessary-condition |
| 53:18 | no-unnecessary-condition |
| 54:18 | no-unnecessary-condition |
| 56:18 | no-unnecessary-condition |
| 71:10 | no-unnecessary-condition |
| 76:10 | no-unnecessary-condition |
| 110:18 | no-unnecessary-condition |

## packages/jira/jira-core/src/commitmsg.test.ts

| 行:列 | 规则 |
|---|---|
| 28:10 | no-unnecessary-condition |
| 75:10 | no-unnecessary-condition |
| 85:10 | no-unnecessary-condition |
| 117:10 | no-unnecessary-condition |

## packages/jira/jira-core/src/config.test.ts

| 行:列 | 规则 |
|---|---|
| 18:8 | no-unnecessary-condition |
| 26:9 | no-unnecessary-condition |
| 55:10 | no-unnecessary-condition |
| 67:10 | no-unnecessary-condition |

## packages/jira/jira-core/src/counters.test.ts

| 行:列 | 规则 |
|---|---|
| 13:8 | no-unnecessary-condition |
| 55:12 | no-unnecessary-condition |
| 115:10 | no-unnecessary-condition |
| 119:20 | no-unnecessary-condition |

## packages/jira/jira-core/src/frontmatter.test.ts

| 行:列 | 规则 |
|---|---|
| 18:8 | no-unnecessary-condition |
| 25:7 | no-unnecessary-condition |

## packages/jira/jira-core/src/generateStore.test.ts

| 行:列 | 规则 |
|---|---|
| 31:8 | no-unnecessary-condition |
| 93:11 | no-unsafe-assignment |
| 99:54 | no-unsafe-member-access |
| 164:18 | no-unnecessary-condition |
| 164:18 | no-unnecessary-condition |
| 179:10 | no-unnecessary-condition |

## packages/jira/jira-core/src/generateStore.ts

| 行:列 | 规则 |
|---|---|
| 362:7 | no-unnecessary-condition |

## packages/jira/jira-core/src/git.test.ts

| 行:列 | 规则 |
|---|---|
| 47:9 | no-unnecessary-condition |
| 52:9 | no-unnecessary-condition |
| 126:11 | no-unnecessary-condition |
| 151:11 | no-unnecessary-condition |
| 179:9 | no-unnecessary-condition |
| 186:9 | no-unnecessary-condition |
| 191:9 | no-unnecessary-condition |
| 206:9 | no-unnecessary-condition |
| 217:12 | no-unnecessary-condition |
| 233:53 | require-await |
| 250:55 | require-await |
| 262:47 | require-await |
| 271:50 | require-await |
| 279:47 | require-await |
| 287:9 | no-unnecessary-condition |
| 296:37 | require-await |
| 299:9 | no-unnecessary-condition |

## packages/jira/jira-core/src/hooks.test.ts

| 行:列 | 规则 |
|---|---|
| 22:8 | no-unnecessary-condition |

## packages/jira/jira-core/src/injection.test.ts

| 行:列 | 规则 |
|---|---|
| 30:8 | no-unnecessary-condition |
| 76:49 | require-await |
| 138:21 | require-await |
| 162:60 | require-await |
| 168:21 | require-await |
| 177:60 | require-await |

## packages/jira/jira-core/src/inspect.test.ts

| 行:列 | 规则 |
|---|---|
| 25:10 | no-unnecessary-condition |
| 90:11 | no-unnecessary-condition |
| 99:20 | no-unnecessary-condition |
| 99:20 | no-unnecessary-condition |
| 125:11 | no-unnecessary-condition |
| 138:9 | no-unnecessary-condition |
| 145:9 | no-unnecessary-condition |

## packages/jira/jira-core/src/inspect.ts

| 行:列 | 规则 |
|---|---|
| 210:86 | no-unnecessary-condition |

## packages/jira/jira-core/src/io.test.ts

| 行:列 | 规则 |
|---|---|
| 61:10 | no-unnecessary-condition |
| 70:10 | no-unnecessary-condition |
| 83:9 | no-unnecessary-condition |
| 95:10 | no-unnecessary-condition |
| 104:10 | no-unnecessary-condition |
| 113:9 | no-unnecessary-condition |
| 130:12 | no-unnecessary-condition |
| 150:12 | no-unnecessary-condition |
| 176:9 | no-unnecessary-condition |
| 182:9 | no-unnecessary-condition |
| 186:10 | no-unnecessary-condition |
| 190:10 | no-unnecessary-condition |
| 199:10 | no-unnecessary-condition |
| 218:10 | no-unnecessary-condition |

## packages/jira/jira-core/src/kb.test.ts

| 行:列 | 规则 |
|---|---|
| 17:8 | no-unnecessary-condition |
| 84:10 | no-unnecessary-condition |
| 106:12 | no-unnecessary-condition |
| 120:10 | no-unnecessary-condition |
| 149:10 | no-unnecessary-condition |
| 188:10 | no-unnecessary-condition |

## packages/jira/jira-core/src/kbsearch.test.ts

| 行:列 | 规则 |
|---|---|
| 107:18 | no-unnecessary-condition |
| 131:10 | no-unnecessary-condition |
| 140:18 | no-unnecessary-condition |

## packages/jira/jira-core/src/kbstore.test.ts

| 行:列 | 规则 |
|---|---|
| 30:8 | no-unnecessary-condition |
| 86:12 | no-unnecessary-condition |
| 95:10 | no-unnecessary-condition |
| 123:10 | no-unnecessary-condition |
| 185:25 | no-unnecessary-condition |
| 186:16 | no-unnecessary-condition |
| 186:16 | no-unnecessary-condition |
| 187:18 | no-unnecessary-condition |
| 235:10 | no-unnecessary-condition |
| 275:18 | no-unnecessary-condition |
| 276:25 | no-unnecessary-condition |

## packages/jira/jira-core/src/list.test.ts

| 行:列 | 规则 |
|---|---|
| 200:79 | require-await |

## packages/jira/jira-core/src/lock.test.ts

| 行:列 | 规则 |
|---|---|
| 26:30 | require-await |
| 51:18 | no-unnecessary-condition |
| 52:9 | no-unnecessary-condition |
| 64:10 | no-unnecessary-condition |
| 68:9 | no-unnecessary-condition |
| 84:9 | no-unnecessary-condition |
| 95:9 | no-unnecessary-condition |
| 108:63 | require-await |
| 114:9 | no-unnecessary-condition |
| 168:10 | no-unnecessary-condition |
| 177:9 | no-unnecessary-condition |
| 259:10 | no-unnecessary-condition |

## packages/jira/jira-core/src/lock.ts

| 行:列 | 规则 |
|---|---|
| 319:35 | no-unnecessary-condition |

## packages/jira/jira-core/src/machine.test.ts

| 行:列 | 规则 |
|---|---|
| 29:8 | no-unnecessary-condition |
| 64:10 | no-unnecessary-condition |
| 77:10 | no-unnecessary-condition |
| 111:23 | require-await |
| 114:10 | no-unnecessary-condition |

## packages/jira/jira-core/src/machines.test.ts

| 行:列 | 规则 |
|---|---|
| 30:8 | no-unnecessary-condition |
| 87:10 | no-unnecessary-condition |
| 104:18 | no-unnecessary-condition |

## packages/jira/jira-core/src/mutate.test.ts

| 行:列 | 规则 |
|---|---|
| 47:8 | no-unnecessary-condition |
| 213:18 | no-unnecessary-condition |
| 325:10 | no-unnecessary-condition |
| 374:10 | no-unnecessary-condition |

## packages/jira/jira-core/src/mutate.ts

| 行:列 | 规则 |
|---|---|
| 182:9 | no-unnecessary-condition |

## packages/jira/jira-core/src/paths.test.ts

| 行:列 | 规则 |
|---|---|
| 49:8 | no-unnecessary-condition |

## packages/jira/jira-core/src/project.test.ts

| 行:列 | 规则 |
|---|---|
| 31:8 | no-unnecessary-condition |
| 152:10 | no-unnecessary-condition |
| 229:10 | no-unnecessary-condition |
| 243:12 | no-unnecessary-condition |

## packages/jira/jira-core/src/provision.test.ts

| 行:列 | 规则 |
|---|---|
| 22:8 | no-unnecessary-condition |

## packages/jira/jira-core/src/push.test.ts

| 行:列 | 规则 |
|---|---|
| 43:45 | require-await |
| 107:9 | no-unnecessary-condition |
| 134:21 | require-await |
| 138:23 | require-await |
| 155:23 | require-await |
| 176:23 | require-await |
| 206:23 | require-await |
| 240:9 | no-unnecessary-condition |
| 272:47 | require-await |
| 315:31 | require-await |
| 339:31 | require-await |
| 356:21 | require-await |
| 357:31 | require-await |
| 380:23 | require-await |
| 411:21 | require-await |

## packages/jira/jira-core/src/rebase.test.ts

| 行:列 | 规则 |
|---|---|
| 33:8 | no-unnecessary-condition |
| 164:47 | require-await |
| 196:47 | require-await |

## packages/jira/jira-core/src/session.test.ts

| 行:列 | 规则 |
|---|---|
| 43:8 | no-unnecessary-condition |
| 100:18 | no-unnecessary-condition |
| 205:10 | no-unnecessary-condition |

## packages/jira/jira-core/src/store-create.test.ts

| 行:列 | 规则 |
|---|---|
| 46:8 | no-unnecessary-condition |
| 102:11 | no-unsafe-assignment |
| 103:23 | no-unsafe-member-access |
| 104:34 | no-unsafe-argument |
| 104:39 | no-unsafe-member-access |
| 105:27 | no-unsafe-member-access |
| 106:11 | no-unsafe-assignment |
| 107:28 | no-unsafe-member-access |
| 158:12 | no-unnecessary-condition |
| 184:14 | no-unnecessary-condition |
| 213:12 | no-unnecessary-condition |
| 219:11 | no-unnecessary-condition |
| 244:14 | no-unnecessary-condition |
| 257:11 | no-unnecessary-condition |

## packages/jira/jira-core/src/store.test.ts

| 行:列 | 规则 |
|---|---|
| 72:8 | no-unnecessary-condition |
| 99:7 | no-unnecessary-condition |
| 123:10 | no-unnecessary-condition |
| 137:32 | require-await |
| 143:10 | no-unnecessary-condition |
| 145:9 | no-unnecessary-condition |
| 180:18 | no-unnecessary-condition |
| 189:10 | no-unnecessary-condition |
| 248:9 | no-unnecessary-condition |
| 258:10 | no-unnecessary-condition |
| 270:10 | no-unnecessary-condition |
| 277:10 | no-unnecessary-condition |
| 290:12 | no-unnecessary-condition |
| 316:9 | no-unnecessary-condition |
| 355:9 | no-unnecessary-condition |
| 402:109 | require-await |

## packages/jira/jira-core/src/tagstore.test.ts

| 行:列 | 规则 |
|---|---|
| 28:8 | no-unnecessary-condition |
| 84:10 | no-unnecessary-condition |
| 93:10 | no-unnecessary-condition |
| 102:12 | no-unnecessary-condition |

## packages/jira/jira-core/src/validate.test.ts

| 行:列 | 规则 |
|---|---|
| 32:10 | no-unnecessary-condition |
| 40:10 | no-unnecessary-condition |
| 44:10 | no-unnecessary-condition |
| 55:12 | no-unnecessary-condition |
| 75:10 | no-unnecessary-condition |
| 79:10 | no-unnecessary-condition |
| 88:9 | no-unnecessary-condition |
| 92:10 | no-unnecessary-condition |
| 105:10 | no-unnecessary-condition |
| 108:10 | no-unnecessary-condition |
| 116:10 | no-unnecessary-condition |

## packages/jira/jira-core/src/vocab-file.test.ts

| 行:列 | 规则 |
|---|---|
| 84:11 | no-unnecessary-condition |
| 101:12 | no-unnecessary-condition |

## packages/jira/jira-core/src/vocab.test.ts

| 行:列 | 规则 |
|---|---|
| 109:12 | no-unnecessary-condition |

## packages/jira/jira-core/src/workspace.test.ts

| 行:列 | 规则 |
|---|---|
| 28:8 | no-unnecessary-condition |

## packages/jira/jira-core/tests/boundaries.spec.ts

| 行:列 | 规则 |
|---|---|
| 74:18 | restrict-plus-operands |
| 85:18 | restrict-plus-operands |

## packages/jira/jira-service/tests/events.spec.ts

| 行:列 | 规则 |
|---|---|
| 89:24 | no-unsafe-member-access |
| 90:24 | no-unsafe-member-access |
| 91:24 | no-unsafe-member-access |

## packages/jira/ui-jira/tests/jira-section.client.spec.tsx

| 行:列 | 规则 |
|---|---|
| 258:19 | unbound-method |
| 261:41 | unbound-method |
| 263:41 | unbound-method |
| 265:41 | unbound-method |
| 271:19 | unbound-method |

## packages/superagent/superagent-core/src/dispatch-store.test.ts

| 行:列 | 规则 |
|---|---|
| 82:22 | no-unnecessary-condition |
| 83:18 | no-unnecessary-condition |
| 83:18 | no-unnecessary-condition |
| 85:33 | require-await |
| 90:22 | no-unnecessary-condition |
| 91:22 | no-unnecessary-condition |
| 103:18 | no-unnecessary-condition |
| 104:18 | no-unnecessary-condition |
| 105:18 | no-unnecessary-condition |
| 106:22 | no-unnecessary-condition |
| 107:22 | no-unnecessary-condition |
| 119:18 | no-unnecessary-condition |
| 120:18 | no-unnecessary-condition |
| 121:22 | no-unnecessary-condition |
| 122:22 | no-unnecessary-condition |
| 142:18 | no-unnecessary-condition |
| 142:41 | no-unnecessary-condition |
| 169:18 | no-unnecessary-condition |
| 170:22 | no-unnecessary-condition |
| 171:22 | no-unnecessary-condition |
| 189:18 | no-unnecessary-condition |
| 190:18 | no-unnecessary-condition |
| 191:18 | no-unnecessary-condition |
| 210:18 | no-unnecessary-condition |
| 211:22 | no-unnecessary-condition |
| 247:18 | no-unnecessary-condition |
| 248:18 | no-unnecessary-condition |
| 248:18 | no-unnecessary-condition |
| 249:18 | no-unnecessary-condition |
| 249:18 | no-unnecessary-condition |
| 259:18 | no-unnecessary-condition |
| 279:18 | no-unnecessary-condition |
| 306:18 | no-unnecessary-condition |

## packages/superagent/superagent-core/src/index.test.ts

| 行:列 | 规则 |
|---|---|
| 57:18 | no-unnecessary-condition |
| 78:18 | no-unnecessary-condition |
| 79:18 | no-unnecessary-condition |
| 105:54 | restrict-plus-operands |
| 131:18 | no-unnecessary-condition |
| 144:18 | no-unnecessary-condition |
| 145:18 | no-unnecessary-condition |
| 146:18 | no-unnecessary-condition |
| 147:18 | no-unnecessary-condition |
| 148:18 | no-unnecessary-condition |
| 154:18 | no-unnecessary-condition |
| 155:18 | no-unnecessary-condition |
| 156:18 | no-unnecessary-condition |
| 157:18 | no-unnecessary-condition |
| 185:18 | no-unnecessary-condition |
| 193:18 | no-unnecessary-condition |
| 194:18 | no-unnecessary-condition |
| 195:18 | no-unnecessary-condition |
| 196:18 | no-unnecessary-condition |
| 197:18 | no-unnecessary-condition |
| 198:18 | no-unnecessary-condition |
| 220:18 | no-unnecessary-condition |
| 221:18 | no-unnecessary-condition |
| 233:18 | no-unnecessary-condition |
| 246:18 | no-unnecessary-condition |
| 278:18 | no-unnecessary-condition |
| 423:18 | no-unnecessary-condition |

## packages/superagent/superagent-core/src/index.ts

| 行:列 | 规则 |
|---|---|
| 188:46 | no-unnecessary-condition |
| 212:45 | no-unnecessary-condition |

## packages/uitstalie/persona-card/src/provider.ts

| 行:列 | 规则 |
|---|---|
| 243:5 | no-unnecessary-condition |

## packages/uitstalie/persona-card/src/state.ts

| 行:列 | 规则 |
|---|---|
| 331:44 | no-unnecessary-condition |

## packages/uitstalie/personality/tests/provider.spec.ts

| 行:列 | 规则 |
|---|---|
| 250:31 | no-unnecessary-type-assertion |
| 252:31 | no-unnecessary-type-assertion |
