# DSH Pet Sharing License · DPSL-1.0

> **English translation of [`PET-SHARING-AGREEMENT.md`](PET-SHARING-AGREEMENT.md).**
> In case of ambiguity, the **Chinese version prevails** (§13.5). Section numbers match one-to-one.
>
> In one sentence: **you keep the copyright; you only license the plugin to index your pet in the
> Community Gallery, show its preview, and offer download + one-click install; you may withdraw at any time.**
>
> | Item | Value |
> | --- | --- |
> | Identifier | `DPSL-1.0` |
> | Version | 1.0 |
> | Published | 2026-09-17 |
> | Discovery topic | `dsh-pet` |
> | Declaration site | `pet.json` → `sharing` block |
> | Full text (zh) | <https://github.com/Stellum-Waq/dsh-pet-ronaldo/blob/master/docs/PET-SHARING-AGREEMENT.md> |
>
> **This is not legal advice.** It is a community-readable authorization text for a small-asset
> gallery. Consult a professional if your work involves commercial interests or third-party rights.

---

## 0. Thirty seconds

| Question | Answer |
| --- | --- |
| Who owns my pet? | **You do** (§4). This license is a grant, not an assignment. |
| What does the plugin take? | Only what indexing/discovery needs: name, author, preview, tags, and the package itself (§3, §10). |
| Can the plugin sell it? | **No.** Commercial sale, sublicensing and paid bundling are explicitly excluded (§3.3). |
| May others remix it? | By default yes, with attribution and the same license; turn it off with `sharing.allowRemix` (§3.4). |
| How do I opt out? | Set `"shared": false` or drop the `dsh-pet` topic; removal from the index within 7 days (§9). |
| Copies already installed elsewhere? | They are local files on someone else's machine; no protocol can recall them — this text says so plainly (§9.4). |
| AI-generated art risk? | Real, and borne by the publisher. The plugin only indexes and transports (§8). |
| Does the plugin upload my files? | **Never.** You push to your own GitHub repo; the plugin only reads (§10). |

---

## 1. Definitions

1.1 **"The Plugin"** — the DSH desktop-pet plugin **dsh-ronaldo-pet** (host half, client half, and the
`dsh-pet-forge` skill), maintained by Stellum-Waq and successor maintainers.

1.2 **"Pet Package"** — a self-describing directory following [`SPRITESHEET-CONTRACT.md`](SPRITESHEET-CONTRACT.md)
and the `pet.json` manifest contract: spritesheet, audio and manifest.

1.3 **"Author"** — the person or organization that created and published the Pet Package; the licensor.

1.4 **"User"** — anyone who downloads, installs or uses a Pet Package through the Plugin.

1.5 **"Community Gallery"** — the Plugin's built-in window and its backing index used to collect,
display, download and one-click install public Pet Packages.

1.6 **"Index"** — the metadata describing package sources, from two origins: the **official index**
(`gallery/index.json` in this repository, joined by pull request) and **automatic discovery**
(public GitHub repositories carrying the `dsh-pet` topic).

1.7 **"Declaration"** — the `sharing` block an Author writes into `pet.json` (Appendix B). It is the
**only** machine-readable way to accept this license.

1.8 **"Withdrawal"** — termination of the grant under §9.

---

## 2. How this license is accepted

2.1 **Silence is not acceptance.** An Author accepts only by doing *all* of the following:

1. write a `sharing` block in the package's root `pet.json` with `"protocol": "DPSL-1.0"`,
   `"shared": true`, and a non-empty `"statement"` (default text in Appendix A);
2. publish the package to a **publicly readable** GitHub repository (§6);
3. add the `dsh-pet` topic to that repository.

2.2 The Plugin asks ("would you like to share this pet with the Community Gallery?") when a pet is
generated, offering *share / not now / never*. **The default is no sharing.**

2.3 The Index is rebuilt from the repository's **current** `sharing` block. Earlier verbal or UI
consent does not waive later edits.

---

## 3. Rights granted

### 3.1 To the Plugin maintainers (non-exclusive, royalty-free, worldwide, revocable)

To operate the Community Gallery: **(a)** index and store public metadata; **(b)** display metadata and
preview images in the Plugin UI, README and release notes; **(c)** provide a download channel,
including fetching archives from the Author's repository and caching/mirroring public archives;
**(d)** validate, unpack and register packages on the User's machine; **(e)** perform technical
processing needed for display and validation (thumbnails, header reads, hashes).

### 3.2 To Users

Users may: **(a)** download, install and use the package locally; **(b)** redistribute the **unmodified**
complete package for **non-commercial** purposes with attribution and this license file preserved;
**(c)** modify assets for personal use (public redistribution of derivatives is governed by §3.4).

### 3.3 Explicitly excluded

Regardless of configuration, this license grants **no** right to: **(a)** commercial use (selling the
package or derivatives, paid bundling, paid services, ad monetization); **(b)** sublicensing or
including the package in another asset market under a different name; **(c)** removing or obscuring
attribution or this license; **(d)** using the Author's name, avatar or trademarks to imply
endorsement; **(e)** training any machine-learning model (including fine-tuning, distillation and
dataset inclusion); **(f)** unlawful or harmful use (§7).

### 3.4 Remix

3.4.1 Default `"allowRemix": true`: others may publish derivatives provided they **(a)** credit the
original author and this license prominently, **(b)** license the derivative under DPSL-1.0,
**(c)** do not imply endorsement, and **(d)** obtain separate permission for commercial use.

3.4.2 `"allowRemix": false` disables public derivative distribution; private local modification
remains allowed (§3.2.c).

3.4.3 Derivatives are independent works owned by their creators; the original Author is not
responsible for them.

---

## 4. Rights reserved by the Author

4.1 **No copyright transfer.** All rights not expressly granted are reserved.

4.2 The Author may withdraw (§9), change the license, or narrow the grant at any time; changes apply
to future conduct from the moment the repository file is updated (§12.3).

4.3 The Author may license the **code** portion under MIT/Apache-2.0 while assets and gallery
inclusion remain governed by this license.

---

## 5. Obligations of the Plugin maintainers

5.1 **Attribution** — display the Author's credit and repository link prominently; never present
someone else's work as the Plugin's own.

5.2 **No tampering** — do not modify package assets or manifests; generated thumbnails are clearly
distinguished from originals.

5.3 **No fees** — indexing, display, download and install are free of charge.

5.4 **No sublicensing** for the uses excluded by §3.3.

5.5 **Withdrawal response** — honour the deadlines in §9.3.

5.6 **Verifiability** — every gallery entry links to its source repository.

5.7 **Honesty** — the UI distinguishes "DPSL-licensed" entries from "listed only, not licensed"
entries; unlicensed content is never presented as licensed.

---

## 6. Publishing requirements

6.1 The repository is publicly readable.

6.2 A root (or single-subdirectory) `pet.json` passes strict validation: atlas size exactly
`cols × cellW` by `rows × cellH`, state rows in range, `idle` present.

6.3 A valid `sharing` block (§2.1) whose `repo` points at that repository.

6.4 Recommended: `DSH-PET-LICENSE.md` (a copy of this license), `preview.png`, `README.md`.

6.5 The `dsh-pet` topic, which is the sole discovery signal.

6.6 Repositories failing 6.2/6.3 may still be **listed** (link + download channel) but are marked
"not DPSL-licensed · listed only" and get no one-click install.

---

## 7. Content policy

7.1 An Author warrants the package contains none of: unlawful content; sexual, violent, terrorist,
hateful or discriminatory content; malicious code or payloads; material infringing copyright,
trademark, likeness, reputation or privacy (including unauthorized fan assets, voices or
photographs); identifiable real persons without consent; false attribution; or off-topic
promotion, crypto and gambling content.

7.2 On discovery or credible report, the maintainers may remove an entry immediately and may
blacklist it locally.

7.3 The maintainers have no duty to pre-screen all content, and act on notice per §7.2 and §9.

---

## 8. Third-party rights (important)

8.1 **AI-generated assets.** Copyrightability and substantial-similarity questions remain unsettled.
**The risk is the Author's**; publishers should confirm their model's terms permit this use and
redistribution.

8.2 **Fan works.** Rights in characters from anime, games, film or sports usually belong to the
original rights holders. The Plugin gives no warranty and accepts no liability.

8.3 **Audio.** No unauthorized commercial music, film clips or third-party voice recordings.

8.4 **Notices and takedown.** Rights holders may submit a notice (work, repository URL, proof of
rights, contact). The maintainers verify and act per §7.2.

8.5 **No warranty.** The index and transport service is provided AS-IS, without warranty of legality
of content, clarity of title, local usability, or continuity of service.

---

## 9. Withdrawal, takedown and termination

9.1 **How to withdraw** (any one, effective immediately): set `sharing.shared` to `false`; delete the
`sharing` block; remove the `dsh-pet` topic; make the repository private or delete it; or open an
issue titled `[withdraw]`.

9.2 Conditions are re-checked on every index refresh.

9.3 **Deadlines** — official-index entries are removed within **7 days** of an explicit request;
auto-discovered entries drop out as soon as the condition fails, with local cache expiring within
**24 hours**.

9.4 **Already-downloaded copies** are unaffected and cannot be recalled; the maintainers neither
possess nor promise remote deletion capability. Authors wanting stronger control should not share,
or should publish install scripts without assets.

9.5 On termination, §3.2 survives for copies already distributed; §5 survives while the service runs;
§8, §11 and §13 survive termination.

---

## 10. Privacy and data

10.1 **The Plugin never uploads your files.** You push to your own repository; the Plugin only reads.
No local paths, conversations, workspace names or usage statistics are uploaded.

10.2 Stored locally: the index cache (`storages/dsh-pet-forge/gallery-cache.json`), downloaded
packages (`storages/dsh-pet-forge/community/<owner>-<repo>/`), and share-kit files you generate.

10.3 Network destinations are limited to `api.github.com`, `codeload.github.com` / `github.com`, and
the official index URL. Networking can be disabled by configuration.

10.4 Credit and repository URLs are already-public information; use a nickname if you prefer.

10.5 After withdrawal, cached metadata is deleted when the cache expires.

---

## 11. Disclaimer and limitation of liability

11.1 The service is provided AS-IS without warranties of merchantability, fitness or non-infringement.

11.2 To the maximum extent permitted by law, the maintainers are not liable for losses arising from
third-party packages, claims by rights holders over Author content, or service unavailability due to
network or GitHub API changes.

11.3 Authors bear full responsibility for their content and will reasonably cooperate regarding
third-party claims arising from it.

11.4 Nothing here excludes liability that cannot lawfully be excluded.

---

## 12. Versions

12.1 The identifier `DPSL-1.0` is the normative version marker.

12.2 Later versions ship as `DPSL-1.1`, `DPSL-2.0`, with history and a changelog entry.

12.3 **No automatic upgrade** — the version in `sharing.protocol` governs. Authors opt in by editing
the identifier.

12.4 If a version proves defective, the maintainers may stop accepting *new* entries under it without
affecting entries already accepted.

---

## 13. Disputes and miscellaneous

13.1 Negotiate in good faith (GitHub issue or other written channel) first.

13.2 Platform mechanisms (GitHub DMCA / content policy) may be used in parallel.

13.3 **Severability** — invalid clauses are replaced in the least invasive way; the rest stands.

13.4 **Entire agreement** for gallery inclusion, superseding prior communications (without affecting
separate code licenses).

13.5 **Language** — the Chinese text prevails on ambiguity; numbering is parallel.

13.6 **No waiver** by non-enforcement.

---

## Appendix A — minimal declaration

```json
{
  "sharing": {
    "protocol": "DPSL-1.0",
    "shared": true,
    "author": "your-nickname",
    "repo": "https://github.com/<you>/<repo>",
    "license": "DPSL-1.0",
    "preview": "preview.png",
    "tags": ["pixel-art", "cat"],
    "contact": "https://github.com/<you>/<repo>/issues",
    "allowRemix": true,
    "allowCommercial": false,
    "attribution": "your-nickname (https://github.com/<you>)",
    "submittedAt": "2026-09-17T00:00:00.000Z",
    "statement": "I created this pet package myself, or I hold distribution rights to all of its assets, and I agree to share it in the DSH Community Gallery under DPSL-1.0, including displaying the preview and offering download and one-click install."
  }
}
```

## Appendix B — `sharing` fields

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `protocol` | string | ✅ | — | must be `"DPSL-1.0"` |
| `shared` | boolean | ✅ | `false` | `false` means withdrawn |
| `author` | string | ✅ | — | displayed credit; use a nickname if you like |
| `repo` | string | ✅ | — | `https://github.com/<owner>/<repo>` |
| `license` | string | ⭕ | `DPSL-1.0` | additional terms may be appended |
| `preview` | string | ⭕ | auto-detected | relative path, ≤ ~512 KB recommended |
| `tags` | string[] | ⭕ | `[]` | 1–6 tags for filtering |
| `contact` | string | ⭕ | repo issues | issue URL or email |
| `allowRemix` | boolean | ⭕ | `true` | see §3.4 |
| `allowCommercial` | boolean | ⭕ | `false` | gallery never turns this on for you |
| `attribution` | string | ⭕ | `author` | appended to the credit line |
| `submittedAt` | string | ⭕ | fetch time | ISO 8601 |
| `statement` | string | ✅ | — | empty means the entry is not accepted |
| `rights` | string | ⭕ | — | rights notes about assets (excluded assets, fan sources, AI generation). Recommended |
| `extra` | object | ⭕ | — | free-form, passed through untouched |

## Appendix C — quick answers

**Do I have to publish everything?** No. Sharing is optional and asked once; "not now" changes nothing locally.

**Can I keep MIT on my code?** Yes. MIT for code plus DPSL for assets and gallery inclusion is normal.

**Fan art?** Technically possible, at your own risk (§8.2); rights holders can request removal.

**Does the plugin push to GitHub for me?** No — it has no credentials for your account and never
uploads on your behalf (§10.1).

**Does one-click install run scripts from the repository?** No. It reads the atlas and `pet.json`
only, and registers per the manifest contract.
