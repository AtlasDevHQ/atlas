import { getPost } from "../data/posts";

export const SITE_URL = "https://www.useatlas.dev";

const PUBLISHER = {
  "@type": "Organization",
  name: "Atlas DevHQ",
  url: SITE_URL,
  logo: {
    "@type": "ImageObject",
    url: `${SITE_URL}/brand/mark-1024.png`,
  },
};

export const organizationJsonLd = {
  "@context": "https://schema.org",
  ...PUBLISHER,
  sameAs: ["https://github.com/AtlasDevHQ/atlas"],
};

export const webSiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "Atlas",
  url: SITE_URL,
};

export function blogPostingJsonLd(slug: string) {
  const post = getPost(slug);
  const url = `${SITE_URL}/blog/${post.slug}`;
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.description,
    datePublished: post.isoDate,
    url,
    mainEntityOfPage: url,
    image: `${SITE_URL}/og.png`,
    author: {
      "@type": "Person",
      name: "Matt Sywulak",
    },
    publisher: PUBLISHER,
  };
}
