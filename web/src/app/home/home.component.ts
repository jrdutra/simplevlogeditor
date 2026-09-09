import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { DesktopService } from '../shared/desktop/desktop.service';
import { HelpPanelComponent } from '../shared/ui/help-panel.component';
import { TOOLS } from '../tools.data';

/**
 * The front of the machine.
 *
 * One title and one grid of six cards. The catalogue is imported rather than
 * repeated, so a tool cannot appear here with a name it does not have on its
 * own page.
 *
 * The help panel at the end of the template is what the chrome's Help button
 * opens here — the tools' pages each supply their own.
 *
 * The page is asked to fit. A front door that has to be scrolled before all
 * six doors are visible is a front door that failed, so on any screen with
 * room for it this becomes a column measured against its height rather than a
 * document measured against its width. The stylesheet decides where that
 * applies; nothing here needs to know.
 */
@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule, RouterLink, HelpPanelComponent],
  templateUrl: './home.component.html',
  styleUrl: './home.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class HomeComponent {
  readonly tools = TOOLS;
  constructor(readonly desktop: DesktopService) {}
}
