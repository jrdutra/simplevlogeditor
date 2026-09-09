import { ChangeDetectionStrategy, Component } from '@angular/core';

import { HelpPanelComponent } from './help-panel.component';

/**
 * What happens to a file that is opened here, written down.
 *
 * It is mounted once in the chassis rather than on each page, because unlike
 * the instructions it says the same thing everywhere — and because a reader
 * who wants to know where their recording goes should not have to find the
 * right page first.
 *
 * Every claim here is a claim about code in this repository: there is no
 * upload in it, and no server to upload to. The one thing that does leave the
 * machine is named, because a privacy notice that mentions only the flattering
 * parts is not one.
 */
@Component({
  selector: 'app-privacy-panel',
  standalone: true,
  imports: [HelpPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-help-panel kind="privacy" label="Privacy">
      <div class="instrucoes">
        <section class="seo-intro">
          <h2>Your files stay on your machine</h2>
          <p><strong>Nothing you open here is uploaded, and nothing is stored on SimpleVlogEditor
            servers.</strong> There is no upload in this software and no server to receive one. When
            you choose a video or an audio file, the browser reads it from your disk, your own
            machine does the work, and the result is written back to a place you choose.</p>
          <p>That is not a policy decision that could quietly change — it is how the tools are
            built. Every one of them decodes, analyses and encodes on this device, which is also
            why a long recording depends on how fast your computer is rather than on how busy a
            service happens to be.</p>
        </section>

        <h2>What we never receive</h2>
        <p>Your videos, your audio, your images, your subtitles, your transcripts and the text of
          anything you type into a tool. None of it is sent anywhere. We cannot read it, cannot
          keep a copy of it, and could not hand it to anyone else if we were asked.</p>

        <h2>What is kept, and where</h2>
        <p>The video editor can remember an edit across a reload. What it saves is the list of
          decisions — the order of the clips, the cuts, the captions, the settings — in your own
          browser's storage, on this device. <strong>The media itself is never copied into that
          storage</strong>: a timeline is routinely gigabytes and the browser's quota is a few
          megabytes, so a restored project comes back complete but waiting, and asks you for the
          same files again.</p>
        <p>Clearing your browser's data for this site removes it. Nobody else can read it.</p>
        <p>The desktop application additionally remembers the size and position of its own window,
          in a small file on your computer. That is all it writes outside the folders you choose.</p>

        <h2>What does leave this device</h2>
        <p>The pages themselves, the code, and the speech and noise-removal models are
          <em>downloaded</em> to your machine — traffic in the other direction. Serving them means
          our host sees the ordinary things any web server sees when a page is requested.</p>
        <p>Type and icons are loaded from Google Fonts, which is a request to Google's servers and
          therefore visible to them. It carries nothing about your files — only that a page asked
          for a font.</p>
        <p>There is no account, no sign-up, no advertising and no analytics of your work inside
          the tools.</p>

        <h2>Permissions you may be asked for</h2>
        <p>Two tools can ask for a microphone or for a screen to be shared: the editor's narration
          recorder and the transcription tool's meeting capture. Your browser or your operating
          system asks first, and either way the recording is treated exactly like a file you
          opened — it stays here.</p>

        <h2>Children</h2>
        <p>These tools collect nothing from anybody, of any age.</p>

        <h2>Questions</h2>
        <p>Ask at <a href="mailto:contato@simplevlogeditor.com">contato&#64;simplevlogeditor.com</a>.</p>
      </div>
    </app-help-panel>
  `
})
export class PrivacyPanelComponent {}
