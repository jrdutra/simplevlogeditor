The Windows downloads live here.

They are written by `electron/scripts/publish-installer.js`, which runs at the
end of `npm run build` in this project — the site is built, the application is
packed from that build, and the files land here and in
`dist/browser/assets/download/` so the folder being deployed is already correct.

    SimpleVlogEditor-Setup.exe       the installer
    SimpleVlogEditor-Portable.zip    the same application, unpacked, run in place
    installer.json                   version and sizes, read by the home page

All three are build output. They are not written by hand, and the home page's
download button points straight at them.
