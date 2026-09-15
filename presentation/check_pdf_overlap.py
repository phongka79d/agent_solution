import fitz
import sys
sys.stdout.reconfigure(encoding='utf-8')

pdf_path = sys.argv[1] if len(sys.argv) > 1 else 'DAC_TA_KY_THUAT_HE_THONG_AI_AGENT.pdf'
print(f'Checking: {pdf_path}')
doc = fitz.open(pdf_path)
for i, page in enumerate(doc):
    rect = page.rect
    blocks = page.get_text('blocks')
    print(f'=== PAGE {i+1} (height={rect.height:.1f}, width={rect.width:.1f}) ===')
    
    # Check bottom overflow
    footer_blocks = [b for b in blocks if 'Trang' in b[4]]
    footer_y = footer_blocks[0][1] if footer_blocks else rect.height - 30
    
    overflows = [b for b in blocks if b[3] > footer_y and 'Trang' not in b[4] and 'AI-REV-SPEC' not in b[4]]
    if overflows:
        print(f'  WARNING: {len(overflows)} blocks overflow into footer area (footer_y={footer_y:.1f})!')
        for b in overflows:
            t = b[4].strip().replace('\n', ' ')
            print(f'    Overflow y=({b[1]:.1f}, {b[3]:.1f}): {t[:70]}')
            
    # Check text overlaps between blocks
    text_blocks = [b for b in blocks if b[6] == 0]
    overlaps = []
    for j in range(len(text_blocks)):
        for k in range(j+1, len(text_blocks)):
            b1, b2 = text_blocks[j], text_blocks[k]
            # check intersection
            if not (b1[2] <= b2[0] or b2[2] <= b1[0] or b1[3] <= b2[1] or b2[3] <= b1[1]):
                x_overlap = min(b1[2], b2[2]) - max(b1[0], b2[0])
                y_overlap = min(b1[3], b2[3]) - max(b1[1], b2[1])
                if y_overlap > 3 and x_overlap > 10:
                    overlaps.append((b1, b2, x_overlap, y_overlap))
    if overlaps:
        print(f'  WARNING: {len(overlaps)} overlapping block pairs found!')
        for b1, b2, xo, yo in overlaps:
            t1 = b1[4].strip().replace('\n', ' ')
            t2 = b2[4].strip().replace('\n', ' ')
            print(f'    Overlap ({xo:.1f}x{yo:.1f}pt): "{t1[:35]}" vs "{t2[:35]}"')
