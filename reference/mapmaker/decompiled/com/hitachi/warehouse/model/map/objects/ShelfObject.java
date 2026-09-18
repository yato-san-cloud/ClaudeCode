/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.map.objects;

import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import com.hitachi.warehouse.model.map.objects.AbstractRectangleObject;
import com.hitachi.warehouse.model.picking.ShelfArea;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Font;
import java.awt.FontMetrics;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.util.Collection;

public class ShelfObject
extends AbstractRectangleObject {
    private static final long serialVersionUID = 3727495959349610541L;
    private ShelfArea shelf;
    private int shelfColorRGB = COL_SHELF.getRGB();
    private transient Color _shelfColor = null;
    public static final Color COL_WALL = new Color(49, 123, 127);
    public static final Color COL_SHELF = new Color(213, 238, 239);
    static final int minFontSize = 3;
    static final int maxFontSize = 100;
    static final Font fontNoShow = new Font("Arial", 0, 0);
    static final Font[] fontForSize = new Font[98];
    private transient StringLabel[] labelCands = null;

    static {
        int size = 3;
        while (size <= 100) {
            ShelfObject.fontForSize[size - 3] = new Font("Arial", 0, size);
            ++size;
        }
    }

    public ShelfArea shelf() {
        return this.shelf;
    }

    public void setShelf(ShelfArea shelf) {
        this.shelf = shelf;
        this.labelCands = null;
    }

    @Override
    public boolean isObstructing() {
        return true;
    }

    public Color shelfColor() {
        if (this._shelfColor == null) {
            this._shelfColor = new Color(this.shelfColorRGB);
        }
        return this._shelfColor;
    }

    public void setShelfColor(Color color) {
        this.shelfColorRGB = color.getRGB() | 0xFF000000;
        this._shelfColor = color;
    }

    @Override
    public void paint(Graphics2D g, MapView mapView) {
        int fromX = mapView.screenXForWorld(this.tl().x);
        int fromY = mapView.screenYForWorld(this.tl().y);
        int toX = mapView.screenXForWorld(this.br().x);
        int toY = mapView.screenYForWorld(this.br().y);
        g.setColor(this.shelfColor());
        g.setStroke(new BasicStroke(1.0f));
        g.fillRect(fromX, fromY, toX - fromX, toY - fromY);
        g.setColor(COL_WALL);
        g.drawRect(fromX, fromY, toX - fromX, toY - fromY);
        g.setColor(Color.BLACK);
        if (this.shelf != null && g.getFont() != fontNoShow) {
            int rectWidth = toX - fromX;
            int rectHeight = toY - fromY;
            StringLabel[] labelCands = this.labelCands();
            if (labelCands != null) {
                FontMetrics met = g.getFontMetrics();
                int cx = fromX + rectWidth / 2;
                int cy = fromY + rectHeight / 2;
                StringLabel[] stringLabelArray = labelCands;
                int n = labelCands.length;
                int n2 = 0;
                while (n2 < n) {
                    StringLabel label = stringLabelArray[n2];
                    if (label.drawIfFits(g, met, cx, cy, rectWidth, rectHeight)) break;
                    ++n2;
                }
            }
        }
    }

    public StringLabel[] labelCands() {
        if (this.labelCands == null) {
            this.labelCands = new StringLabel[]{new StringLabel(String.valueOf(this.shelf.colStr()) + ":" + this.shelf.rowStr()), new StringLabel(String.valueOf(this.shelf.colStr()) + "\n" + this.shelf.rowStr()), new StringLabel(String.valueOf(this.shelf.colStr()), String.valueOf(this.shelf.rowStr()))};
        }
        return this.labelCands;
    }

    public int pickLargestFontSize(Graphics2D g, MapView mapView, int currentMaxSize, int screenWidth, int screenHeight) {
        int fromX = mapView.screenXForWorld(this.tl().x);
        int fromY = mapView.screenYForWorld(this.tl().y);
        int toX = mapView.screenXForWorld(this.br().x);
        int toY = mapView.screenYForWorld(this.br().y);
        if (toX <= 0 || toY <= 0 || fromX >= screenWidth || fromY >= screenHeight) {
            return currentMaxSize;
        }
        int rectWidth = toX - fromX;
        int rectHeight = toY - fromY;
        StringLabel[] labelCands = this.labelCands();
        int fontSize = currentMaxSize;
        while (fontSize >= 3) {
            g.setFont(fontForSize[fontSize - 3]);
            FontMetrics met = g.getFontMetrics();
            boolean ok = false;
            StringLabel[] stringLabelArray = labelCands;
            int n = labelCands.length;
            int n2 = 0;
            while (n2 < n) {
                StringLabel label = stringLabelArray[n2];
                if (label.fits(met, rectWidth, rectHeight)) {
                    ok = true;
                    break;
                }
                ++n2;
            }
            if (ok) {
                return fontSize;
            }
            --fontSize;
        }
        return fontSize;
    }

    public static void paintShelfObjects(Collection<ShelfObject> shelfObjects, Graphics2D g, MapView mapView, boolean showLabels, boolean showStartEndShelf) {
        int screenWidth = mapView.getWidth();
        int screenHeight = mapView.getHeight();
        if (showLabels) {
            int fontSize = 100;
            for (ShelfObject obj : shelfObjects) {
                fontSize = Math.min(fontSize, obj.pickLargestFontSize(g, mapView, fontSize, screenWidth, screenHeight));
            }
            if (fontSize < 3) {
                g.setFont(fontNoShow);
            } else {
                g.setFont(fontForSize[fontSize - 3]);
            }
        } else {
            g.setFont(fontNoShow);
        }
        for (ShelfObject obj : shelfObjects) {
            if (!showStartEndShelf && obj.shelf.equals(ShelfArea.pickingStartEndShelf)) continue;
            obj.paint(g, mapView);
        }
    }

    public String toString() {
        return "Shelf:" + this.shelf;
    }

    @Override
    public AbstractObject hardClone() {
        ShelfObject newObj = new ShelfObject();
        newObj.shelf = this.shelf;
        newObj.shelfColorRGB = this.shelfColorRGB;
        newObj.setBounds(this.tl(), this.br());
        return newObj;
    }

    public static class StringLabel {
        public final String[] pieces;

        public StringLabel(String ... pieces) {
            this.pieces = pieces;
        }

        public boolean fits(FontMetrics met, int rectWidth, int rectHeight) {
            int strWidth = 0;
            int strHeight = 0;
            int pieceHeight = met.getHeight();
            String[] stringArray = this.pieces;
            int n = this.pieces.length;
            int n2 = 0;
            while (n2 < n) {
                String piece = stringArray[n2];
                strWidth = Math.max(strWidth, met.stringWidth(piece));
                strHeight += pieceHeight;
                if (strWidth >= rectWidth) {
                    return false;
                }
                if (strHeight >= rectHeight) {
                    return false;
                }
                ++n2;
            }
            return true;
        }

        public boolean drawIfFits(Graphics g, FontMetrics met, int cx, int cy, int rectWidth, int rectHeight) {
            int strWidth = 0;
            int strHeight = 0;
            int pieceHeight = met.getHeight();
            String[] stringArray = this.pieces;
            int n = this.pieces.length;
            int n2 = 0;
            while (n2 < n) {
                String piece = stringArray[n2];
                strWidth = Math.max(strWidth, met.stringWidth(piece));
                strHeight += pieceHeight;
                if (strWidth >= rectWidth) {
                    return false;
                }
                if (strHeight >= rectHeight) {
                    return false;
                }
                ++n2;
            }
            int top = cy - strHeight / 2;
            int i = 0;
            while (i < this.pieces.length) {
                int pieceTop = top + i * pieceHeight;
                int pieceLeft = cx - met.stringWidth(this.pieces[i]) / 2;
                g.drawString(this.pieces[i], pieceLeft, pieceTop + met.getAscent());
                ++i;
            }
            return true;
        }
    }
}

