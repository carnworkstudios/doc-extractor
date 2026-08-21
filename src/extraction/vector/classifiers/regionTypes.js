// regionTypes.js — shared RegionType constants for all classifier modules.

export const RegionType = {
    LATTICE_TABLE: 'LATTICE_TABLE',
    STREAM_TABLE:  'STREAM_TABLE',
    TABLE:         'TABLE',
    PARAGRAPH:     'PARAGRAPH',
    // Display math. Not produced by the geometric classifier: a PARAGRAPH is
    // promoted to MATH by the assembler when its glyphs reconstruct to LaTeX,
    // and the user can assign it by hand to force the math path on a region the
    // detector refused (or turn it off through the Regions legend).
    MATH:          'MATH',
    HEADING:       'HEADING',
    LIST:          'LIST',
    // A bibliography block. Not geometric: the reference detector promotes a
    // PARAGRAPH/LIST whose text reads as a run of "Surname, A. B., …" entries,
    // because a reference list is prose to every geometric test there is.
    REFERENCE:     'REFERENCE',
    IMAGE:         'IMAGE',
    BOX:           'BOX',
    DIVIDER:       'DIVIDER',
    HEADER:        'HEADER',
    FOOTER:        'FOOTER',
};
