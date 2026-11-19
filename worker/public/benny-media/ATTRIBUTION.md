# Benny example-photo attribution

These are real photographs sourced from Wikimedia Commons, verified on
2026-11-19. They are illustrative demo inputs, not evidence of recognition
accuracy or the outcome of live model inference. No private user photo is used.

| Local image | Original title and exact source page | Author | Image license |
|---|---|---|---|
| [can.jpg](can.jpg) | [Faygo Grape Soda Can.jpg](https://commons.wikimedia.org/wiki/File:Faygo_Grape_Soda_Can.jpg) | Joe Ross from Lansing, Michigan | [CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0/) |
| [hand.jpg](hand.jpg) | [Right Hand Palm.png](https://commons.wikimedia.org/wiki/File:Right_Hand_Palm.png) | Eyefive45 | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| [wood.jpg](wood.jpg) | [Piece of wood 123424321.jpg](https://commons.wikimedia.org/wiki/File:Piece_of_wood_123424321.jpg) | JohnnyEnglish1234 | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |

The can photo originally came from Joe Ross's Flickr photo,
[That's why we drink Faygo](https://www.flickr.com/photos/joeross/52486888570/),
as recorded by Commons. Its Commons category records a Flickr license review.
The other two Commons pages identify the named uploaders' own work.

## Changes and redistribution

All three local images were derived from the Commons-served thumbnails, with
EXIF orientation honored and proportional resizing to fit within 800×800 pixels,
RGB baseline JPEG conversion/recompression and metadata removal. No crop,
background replacement, synthetic content or object manipulation was performed.
The hand source was PNG; its local copy is JPEG.

The can image derivative remains licensed under CC BY-SA 2.0 and the hand image
derivative remains licensed under CC BY-SA 4.0. Preserve appropriate author/source
attribution, license links and this changes notice when redistributing them,
including when embedding their bytes in a single HTML file. ShareAlike applies to
the adapted images; do not present them as exclusively covered by the repository's
source-code license. Wood is CC0; its provenance is retained for transparency.
No photographer or depicted brand endorses Benny. Copyright licenses do not grant
trademark or personality/privacy rights; the can's brand is incidental to depicting
a drink can and the isolated hand is not presented as endorsing anything.

[credits.json](credits.json) is the machine-readable attribution manifest keyed
`can`, `hand`, `wood`, including source/license URLs, modification notices, final
SHA-256, byte size/dimensions and the downloaded thumbnail's hash/URL.
[wikimedia-license-metadata.json](wikimedia-license-metadata.json) preserves the
Commons `imageinfo`/`extmetadata` responses used to verify title, author and license.

Visual review confirmed a single drink can, an empty bare palm isolated on white,
and a long wood board on concrete, respectively. All local JPEGs decode and are
under 120,000 bytes. Sample response labels remain simulated regardless of the
fact that their displayed input photos are real.
