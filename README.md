# Route Sheet Distributor

**What it does, in one sentence:** you give it today's route sheet PDF, and it works out which driver each page belongs to, then turns each page into a neat email the driver can read on their phone.

**Why you can trust it:** it only matches a page to a driver when the Transporter ID matches *exactly*. If something doesn't line up, it never guesses. It stops, tells you what's wrong in plain words, and lets you decide.

---

## Install (Windows)

1. **Download the app.** Go to the [latest release](https://github.com/JoMoCodes/Route-Sheets-Distributor/releases/latest). Under **Assets**, click the file whose name starts with `Route-Sheet-Distributor-Setup` and ends in `.exe`.
2. **Open the file you downloaded.** You'll usually find it in your **Downloads** folder.
3. **If Windows shows a blue "Windows protected your PC" box,** click **More info**, then **Run anyway**. This appears because the app isn't registered with Microsoft (that costs money), not because anything is wrong.
4. **Follow the installer.** Keep the default choices and click **Next** / **Install**, then **Finish**. You'll get a **Route Sheet Distributor** shortcut on your desktop and in the Start menu.

That's it. From now on the app **updates itself**: when a new version is out, a green **Restart to update** button appears at the bottom-left of the app.

> **Can't install programs on this computer?** On the same release page, download the file ending in `-portable.exe` instead. Double-click it and the app runs straight away, with no installing. It won't update itself, though, so you'll need to download the newest one yourself now and then.

---

## Using it every day

### Step 1: Give it your driver list (only once)

Click **Import…** on the **Associate Data** box and pick your Associate Data `.csv`.

The app remembers it. You only do this again when your list changes, like when someone new starts or you add email addresses.

### Step 2: Give it today's files

- On the **Route Sheet PDF** box, click **Import…** and pick today's route sheet PDF.
- On the **Routes File** box, click **Import…** and pick today's Routes export (the `.xlsx`).

**Shortcut:** drag all the files onto the app window at once.

### Step 3: Check the Distribute page

The boxes along the top count everything up for you. Then work down the page:

- **Ready to send:** a perfect match. Nothing to do.
- **Choose who gets these route sheets:** the route lists two (or more) drivers, and you pick who gets the sheet. Click **Send to [name]** on the right person, or **Don't send**.
  - A green **★ Suggested** tag shows when the choice seems obvious. For example, the other driver is also listed on other routes.
  - **Accept all suggestions** picks every suggested driver in one click. You can still change any of them afterwards.
- **No exact match:** the app couldn't find the right driver, and it tells you why. For example, the driver isn't on your list or is marked INACTIVE. Choose who should get it from the drop-down and click **Assign**, or click **Don't send**.
- **On the routes file but missing from the PDF:** there's no page for that route, so there's nothing to send. Get the missing page and import the PDF again.
- **People who won't get a route sheet:** a list of every driver who is getting nothing right now, and why. Check this before you send anything.
- **All routes:** every route in one table. Click a row to see its sheet. If you made a choice, **Change** lets you undo it.

### Step 4: Send the sheets

Open the **Route Sheets** page and click a route on the left. You'll see exactly what the driver's email will look like. Then pick one:

| Button | What it does |
|---|---|
| **Copy for email** | Copies the sheet. Paste it into any email (Ctrl+V) and the table keeps its layout. |
| **Open email draft** | Opens a ready-to-send Outlook email with the driver's address, a subject, the sheet, and the original PDF page attached. |
| **Copy + open mail app** | Copies the sheet and opens your normal email app with the address and subject filled in. Paste the sheet into the body. |
| **Save PDF page** | Saves just this route's page from the original PDF. |
| **View original page** | Opens this route's page from the original PDF so you can double-check it. |

After you copy or open a draft, the route gets a ✓ so you can see what you've done. You can also click **Mark as sent**.

**Doing them all at once:** **Export all** (top right) saves an email draft and a PDF for every route that's ready, plus a summary report, into a folder you choose.

### Coming back later

Every day's work is saved, including your choices. Open **History** to reopen an older day. **New run** (top right) starts a fresh one.

---

## How it makes sure nothing is wrong

**A sheet only goes out on its own when all four of these are true:**

1. The route has a page in the PDF.
2. The numbers on that page add up. The app counts the bags and overflow packages itself and checks that they match the totals printed on the page.
3. The Routes file lists exactly **one** driver for that route.
4. That driver's Transporter ID is on your driver list and marked **ACTIVE**.

If any of these fail, the route waits for you, with the reason shown.

**Some other things it does:**

- **It matches by Transporter ID, never by name.** Names are only compared as a double-check: "Alex Rivera" and "Alex James Rivera" are fine, but a completely different name gets a warning.
- **Blank stays blank.** If the original sheet has an empty box (like a missing Sort Zone), the app keeps it empty and points it out to you and to the driver. It never fills it in or shifts the row.
- **Nothing gets lost.** A route with no page, or a page with no route, is always listed with the reason.

---

## Where your data lives

Everything stays **on your computer**, in `%APPDATA%\Route Sheet Distributor\data`. Click **Open data folder** in the app to see it. Nothing is uploaded anywhere.

---

## For whoever maintains the app

### Releasing a new version

1. Open `package.json` and bump `"version"` (for example `1.0.0` → `1.0.1`).
2. Commit and push to `main`.

GitHub then tests the app, builds it, and publishes the new release by itself. Everyone's installed app picks it up within a few hours, or the next time they open it.

Good to know:

- Pushing to `main` **without** changing the version builds and tests the app but doesn't release anything.
- Updates only work while this repository is **public**, because the app downloads updates without logging in.

### Working on the code

```bash
npm install        # one-time setup
npm start          # run the app
npm test           # run the automated checks (uses made-up data)
npm run dist       # build the Windows installer (run this on Windows)
```

| File | What it handles |
|---|---|
| `src/core/pdfParser.js` | Reads the route sheet PDF and checks that the numbers add up |
| `src/core/tableParsers.js` | Reads the Associate Data and Routes files |
| `src/core/matcher.js` | Decides who gets each sheet, and explains why not |
| `src/core/emailRender.js`, `src/core/exporter.js` | Builds the email, Outlook drafts and single-page PDFs |
| `src/core/service.js`, `src/core/store.js` | Saves each day's work and your choices |
| `src/renderer/` | The screens you click on |

**Never commit real driver or route files.** `.gitignore` already blocks the usual export file names.
