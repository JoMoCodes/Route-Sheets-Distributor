# Route Sheet Distributor

A Windows desktop app that matches each page of a route sheet PDF to the right driver by **exact Transporter ID**. It lets you settle routes that list more than one Transporter ID, and turns every route sheet into a clean, email-ready table the driver can read on their phone.

Anything that can't be matched exactly is never sent silently. The app shows you which routes and people won't get a route sheet, why, and lets you pick who it should go to.

## Install (Windows)

1. Open the repo's **Releases** page and download the latest `Route-Sheet-Distributor-Setup-<version>.exe` installer. Before the first release is published, use the **Actions** tab → **Build Windows app** → latest run → **Route-Sheet-Distributor-Windows** artifact instead.
2. Run `Route-Sheet-Distributor-Setup-1.0.0.exe` to install it, or `Route-Sheet-Distributor-1.0.0-portable.exe` to run it without installing.

The build isn't code-signed, so Windows SmartScreen may warn the first time. Choose **More info → Run anyway**.

## Updates

The installed app checks GitHub Releases when it starts and every 4 hours after that. It downloads a new version in the background, then shows **Restart to update** at the bottom of the sidebar. If you don't restart, the update installs the next time you close the app.

- Updates need the repository to be **public**, because the app downloads releases without a login.
- The **portable** `.exe` can't update itself. Use the installer if you want automatic updates.

### Publishing an update

1. Change `"version"` in `package.json` (for example `1.0.0` → `1.0.1`).
2. Commit and push it to `main`.
3. The **Build Windows app** workflow tests and builds the app, then publishes the **v1.0.1** release and its tag. Installed copies pick it up on their next check.

Pushes to `main` that don't change the version are built and tested but not released. Pushing a `v*` tag also publishes, as long as it matches the `package.json` version.

## Daily use

1. **Associate Data**: import your Associate Data `.csv`. It's saved, so you only re-import it when the roster changes (for example, when you add emails).
2. **Route sheet PDF + Routes file**: import the day's route sheet PDF and the Routes export `.xlsx`, or drag all the files onto the window at once.
3. **Distribute page**:
   - **Ready to send**: exact, verified matches. Nothing to do.
   - **Choose who gets these route sheets**: routes listing more than one Transporter ID, e.g. `A1EXAMPLE0001|A2EXAMPLE0002`. Each person shows their status and email, and any other routes they're listed on. The app suggests one when there's a clear pick: the only active person, or the only one not also listed on another route. **Accept all suggestions** applies every suggestion at once.
   - **No exact match**: sheets that can't be matched, with the reason. Pick who it should go to from your associate list, or choose **Don't send**.
   - **People who won't get a route sheet**: everyone named on the routes file who currently gets nothing, and why.
4. **Route Sheets page**: preview exactly what the driver will see, then:
   - **Copy for email**: paste into any email with the tables intact.
   - **Open email draft**: an Outlook draft with the address, subject, formatted sheet, and the original PDF page attached.
   - **Copy + open mail app**: your default mail app with the address and subject filled in. Paste the sheet into the body.
   - **Save PDF page / View original page**: the untouched page from the source PDF.
5. **Export all** saves an email draft and a PDF for every ready route, plus a `Distribution summary.html` and `.csv`.

Every run (station, date and cycle) is saved with your decisions under **History**.

## How matching stays exact

- A route sheet is sent automatically **only** when:
  - the route has a page in the PDF,
  - that page's numbers add up,
  - the routes file lists exactly **one** Transporter ID for it,
  - and that ID is **ACTIVE** in the Associate Data.
- Matching is by Transporter ID only. Names are compared only as a warning (for example, "Alex Rivera" matches "Alex James Rivera"; a different name is flagged).
- Every PDF page is checked: the bag rows must match the "N bags" heading, the overflow rows must add up to the "N overflow" heading, and bags plus overflow must equal **Total Packages**. A page that fails is held for review.
- Cells that are blank on the original sheet (such as a missing Sort Zone) stay blank. They're called out in the app and in the driver's email, rather than shifting the row.
- Routes on the routes file that have no PDF page, and PDF pages with no route on the routes file, are both listed with the reason.

## Where data is stored

Data is stored in `%APPDATA%\Route Sheet Distributor\data`. The app has an **Open data folder** button. Nothing is uploaded anywhere.

## Development

```bash
npm install
npm start          # run the app
npm test           # parser, matching, and export tests (synthetic data)
npm run dist       # build Windows installer + portable exe (run on Windows)
```

The code lives in `src/core/`:

- `pdfParser.js`: route sheet PDF to structured data, with self-checks.
- `tableParsers.js`: Associate Data and Routes files.
- `matcher.js`: who gets each route sheet, and why not.
- `emailRender.js` and `exporter.js`: email HTML, `.eml` drafts, single-page PDFs.
- `service.js` and `store.js`: runs, decisions and local storage.

The UI is in `src/renderer/`.

Don't commit real associate or route files. `.gitignore` excludes the usual export names.
