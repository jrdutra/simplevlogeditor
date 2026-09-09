import { DOCUMENT } from '@angular/common';
import { Inject, Injectable } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, NavigationEnd, Router } from '@angular/router';
import { filter, map, mergeMap } from 'rxjs/operators';

export const SITE_NAME = 'SimpleVlogEditor';
export const SITE_ORIGIN = 'https://simplevlogeditor.com';

export interface SeoItem {
  name: string;
  description: string;
  path: string;
}

/**
 * Everything a route wants to say about itself, in one object hung on
 * `data.seo`. Nothing here is required beyond a title and a path: the service
 * fills in the rest from the site's own defaults, so a new route cannot ship
 * without a canonical URL or an Open Graph card.
 */
export interface SeoData {
  title: string;
  description: string;
  keywords?: string;
  canonicalPath: string;
  imagePath?: string;
  imageAlt?: string;
  imageWidth?: number;
  imageHeight?: number;
  /** Rendered as an ItemList — used by the home page for the tool grid. */
  toolItems?: readonly SeoItem[];
  /** Rendered as a SoftwareApplication — used by every tool page. */
  application?: { name: string; description: string };
}

const DEFAULT_IMAGE = '/assets/tools/video-editor-cover.jpg';

@Injectable({ providedIn: 'root' })
export class SeoService {
  private started = false;

  constructor(
    private readonly router: Router,
    private readonly route: ActivatedRoute,
    private readonly title: Title,
    private readonly meta: Meta,
    @Inject(DOCUMENT) private readonly document: Document
  ) {}

  /**
   * Starts following the router.
   *
   * Called once from the shell rather than in the constructor, because a
   * service that subscribes when it is first injected subscribes at a moment
   * nobody chose.
   */
  init(): void {
    if (this.started) return;
    this.started = true;

    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        map(() => this.route),
        map((route) => {
          let deepest = route;
          while (deepest.firstChild) deepest = deepest.firstChild;
          return deepest;
        }),
        mergeMap((route) => route.data)
      )
      .subscribe((data) => this.apply(data['seo'] as SeoData | undefined));
  }

  private apply(seo: SeoData | undefined): void {
    if (!seo) return;

    const fullTitle = `${seo.title} — ${SITE_NAME}`;
    const url = `${SITE_ORIGIN}${seo.canonicalPath === '/' ? '' : seo.canonicalPath}`;
    const image = `${SITE_ORIGIN}${seo.imagePath ?? DEFAULT_IMAGE}`;

    this.title.setTitle(fullTitle);
    this.set('description', seo.description);
    if (seo.keywords) this.set('keywords', seo.keywords);
    this.set('robots', 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1');

    this.setProperty('og:title', fullTitle);
    this.setProperty('og:description', seo.description);
    this.setProperty('og:type', 'website');
    this.setProperty('og:url', url);
    this.setProperty('og:site_name', SITE_NAME);
    this.setProperty('og:image', image);
    if (seo.imageAlt) this.setProperty('og:image:alt', seo.imageAlt);
    if (seo.imageWidth) this.setProperty('og:image:width', String(seo.imageWidth));
    if (seo.imageHeight) this.setProperty('og:image:height', String(seo.imageHeight));

    this.set('twitter:card', 'summary_large_image');
    this.set('twitter:title', fullTitle);
    this.set('twitter:description', seo.description);
    this.set('twitter:image', image);

    this.setCanonical(url);
    this.setJsonLd(this.buildJsonLd(seo, url, image));
  }

  private set(name: string, content: string): void {
    this.meta.updateTag({ name, content });
  }

  private setProperty(property: string, content: string): void {
    this.meta.updateTag({ property, content }, `property='${property}'`);
  }

  private setCanonical(url: string): void {
    const head = this.document.head;
    let link = head.querySelector<HTMLLinkElement>("link[rel='canonical']");
    if (!link) {
      link = this.document.createElement('link');
      link.setAttribute('rel', 'canonical');
      head.appendChild(link);
    }
    link.setAttribute('href', url);
  }

  /**
   * Replaces the structured data block.
   *
   * There is exactly one, marked with an attribute of its own so that the block
   * written into `index.html` is the block this replaces — two competing
   * descriptions of the same page is the one failure mode here that no
   * validator would catch.
   */
  private setJsonLd(payload: unknown): void {
    const head = this.document.head;
    let script = head.querySelector<HTMLScriptElement>("script[data-seo-json-ld='true']");
    if (!script) {
      script = this.document.createElement('script');
      script.setAttribute('type', 'application/ld+json');
      script.setAttribute('data-seo-json-ld', 'true');
      head.appendChild(script);
    }
    script.textContent = JSON.stringify(payload, null, 2);
  }

  private buildJsonLd(seo: SeoData, url: string, image: string): unknown {
    const graph: unknown[] = [
      {
        '@type': 'WebSite',
        '@id': `${SITE_ORIGIN}#website`,
        name: SITE_NAME,
        alternateName: 'simplevlogeditor.com',
        url: SITE_ORIGIN,
        inLanguage: 'en',
        description:
          'Free browser-based video and audio tools for vloggers. Nothing is uploaded — every file stays on your machine.'
      },
      {
        '@type': 'WebPage',
        '@id': `${url}#webpage`,
        url,
        name: seo.title,
        description: seo.description,
        isPartOf: { '@id': `${SITE_ORIGIN}#website` },
        primaryImageOfPage: image,
        inLanguage: 'en'
      }
    ];

    if (seo.application) {
      graph.push({
        '@type': 'SoftwareApplication',
        name: seo.application.name,
        description: seo.application.description,
        applicationCategory: 'MultimediaApplication',
        operatingSystem: 'Any browser',
        url,
        image,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }
      });
    }

    if (seo.toolItems?.length) {
      graph.push({
        '@type': 'ItemList',
        name: `${SITE_NAME} tools`,
        itemListElement: seo.toolItems.map((item, index) => ({
          '@type': 'ListItem',
          position: index + 1,
          name: item.name,
          description: item.description,
          url: `${SITE_ORIGIN}${item.path}`
        }))
      });
    }

    return { '@context': 'https://schema.org', '@graph': graph };
  }
}
