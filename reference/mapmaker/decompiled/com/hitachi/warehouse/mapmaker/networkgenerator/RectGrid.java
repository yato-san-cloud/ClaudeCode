/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.networkgenerator;

import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.map.objects.AbstractRectangleObject;
import common.ds.FixedArrayList;
import common.util.MathUtil;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;

public class RectGrid<T extends AbstractRectangleObject> {
    double gridSize_mm = 5000.0;
    public final Coord tl;
    public final Coord br;
    FixedArrayList<T>[][] grid;
    int width;
    int height;
    Class<T> clazz;
    public static boolean VERBOSE = false;

    public RectGrid(Coord tl, Coord br, double gridSize_mm, Class<T> clazz) {
        this.tl = tl;
        this.br = br;
        this.clazz = clazz;
        this.gridSize_mm = gridSize_mm;
        this.width = this.idxForX(br.x) + 1;
        this.height = this.idxForY(br.y) + 1;
        this.grid = new FixedArrayList[this.width][this.height];
    }

    public void add(T rect) {
        int fromX = this.idxForX(((AbstractRectangleObject)rect).tl().x);
        int fromY = this.idxForY(((AbstractRectangleObject)rect).tl().y);
        int toX = this.idxForX(((AbstractRectangleObject)rect).br().x);
        int toY = this.idxForY(((AbstractRectangleObject)rect).br().y);
        int x = fromX;
        while (x <= toX) {
            int y = fromY;
            while (y <= toY) {
                FixedArrayList<T> bin = this.binAt(x, y, true);
                if (bin != null) {
                    bin.add(rect);
                }
                ++y;
            }
            ++x;
        }
    }

    public void commit() {
        int x = 0;
        while (x < this.width) {
            int y = 0;
            while (y < this.height) {
                if (this.grid[x][y] != null) {
                    this.grid[x][y].rawArray();
                }
                ++y;
            }
            ++x;
        }
    }

    public boolean collides_ignore(Coord coord, T ignore) {
        int y;
        int x = this.idxForX(coord.x);
        FixedArrayList<T> bin = this.binAt(x, y = this.idxForY(coord.y), false);
        if (bin == null) {
            return false;
        }
        AbstractRectangleObject[] abstractRectangleObjectArray = (AbstractRectangleObject[])bin.rawArray();
        int n = abstractRectangleObjectArray.length;
        int n2 = 0;
        while (n2 < n) {
            AbstractRectangleObject rect = abstractRectangleObjectArray[n2];
            if (ignore != rect && rect.isInside(coord)) {
                return true;
            }
            ++n2;
        }
        return false;
    }

    public boolean collidesAny(Coord coord) {
        int y;
        int x = this.idxForX(coord.x);
        FixedArrayList<T> bin = this.binAt(x, y = this.idxForY(coord.y), false);
        if (bin == null) {
            return false;
        }
        AbstractRectangleObject[] abstractRectangleObjectArray = (AbstractRectangleObject[])bin.rawArray();
        int n = abstractRectangleObjectArray.length;
        int n2 = 0;
        while (n2 < n) {
            AbstractRectangleObject rect = abstractRectangleObjectArray[n2];
            if (rect.isInside(coord)) {
                return true;
            }
            ++n2;
        }
        return false;
    }

    public Collection<T> getColliding(Coord coord) {
        int y;
        ArrayList<AbstractRectangleObject> colliding = new ArrayList<AbstractRectangleObject>();
        int x = this.idxForX(coord.x);
        FixedArrayList<T> bin = this.binAt(x, y = this.idxForY(coord.y), false);
        if (bin != null) {
            AbstractRectangleObject[] abstractRectangleObjectArray = (AbstractRectangleObject[])bin.rawArray();
            int n = abstractRectangleObjectArray.length;
            int n2 = 0;
            while (n2 < n) {
                AbstractRectangleObject rect = abstractRectangleObjectArray[n2];
                if (rect.isInside(coord)) {
                    colliding.add(rect);
                }
                ++n2;
            }
        }
        return colliding;
    }

    public T getFirstColliding(Coord coord) {
        int y;
        int x = this.idxForX(coord.x);
        FixedArrayList<T> bin = this.binAt(x, y = this.idxForY(coord.y), false);
        if (bin == null) {
            return null;
        }
        AbstractRectangleObject[] abstractRectangleObjectArray = (AbstractRectangleObject[])bin.rawArray();
        int n = abstractRectangleObjectArray.length;
        int n2 = 0;
        while (n2 < n) {
            AbstractRectangleObject rect = abstractRectangleObjectArray[n2];
            if (rect.isInside(coord)) {
                return (T)rect;
            }
            ++n2;
        }
        return null;
    }

    public boolean clipsAny(Coord from, Coord to) {
        if (from.equals(to)) {
            return this.collidesAny(from);
        }
        double fromX = from.x;
        double fromY = from.y;
        double toX = to.x;
        double toY = to.y;
        if (Math.abs(toY - fromY) > Math.abs(toX - fromX)) {
            if (fromY > toY) {
                double t2 = toX;
                toX = fromX;
                fromX = t2;
                t2 = toY;
                toY = fromY;
                fromY = t2;
            }
            double m = (toX - fromX) / (toY - fromY);
            int fromYIdx = MathUtil.bound(this.idxForY(fromY), 0, this.height - 1);
            int toYIdx = MathUtil.bound(this.idxForY(toY), 0, this.height - 1);
            if (toX >= fromX) {
                int nextCurrentX = MathUtil.bound(this.idxForX((this.yForIdx(fromYIdx) - fromY) * m + fromX), 0, this.width - 1);
                int y = fromYIdx;
                while (y <= toYIdx) {
                    int currentX = nextCurrentX;
                    int nextX = MathUtil.bound(this.idxForX((this.yForIdx(y + 1) - fromY) * m + fromX), 0, this.width - 1);
                    int x = currentX;
                    while (x <= nextX) {
                        FixedArrayList<T> bin = this.grid[x][y];
                        if (bin != null) {
                            AbstractRectangleObject[] abstractRectangleObjectArray = (AbstractRectangleObject[])bin.rawArray();
                            int n = abstractRectangleObjectArray.length;
                            int n2 = 0;
                            while (n2 < n) {
                                AbstractRectangleObject rect = abstractRectangleObjectArray[n2];
                                if (rect.clipsSegment(from, to)) {
                                    return true;
                                }
                                ++n2;
                            }
                        }
                        ++x;
                    }
                    nextCurrentX = nextX;
                    ++y;
                }
            } else {
                int nextCurrentX = MathUtil.bound(this.idxForX((this.yForIdx(fromYIdx) - fromY) * m + fromX), 0, this.width - 1);
                int y = fromYIdx;
                while (y <= toYIdx) {
                    int currentX = nextCurrentX;
                    int nextX = MathUtil.bound(this.idxForX((this.yForIdx(y + 1) - fromY) * m + fromX), 0, this.width - 1);
                    int x = currentX;
                    while (x >= nextX) {
                        FixedArrayList<T> bin = this.grid[x][y];
                        if (bin != null) {
                            AbstractRectangleObject[] abstractRectangleObjectArray = (AbstractRectangleObject[])bin.rawArray();
                            int n = abstractRectangleObjectArray.length;
                            int n3 = 0;
                            while (n3 < n) {
                                AbstractRectangleObject rect = abstractRectangleObjectArray[n3];
                                if (rect.clipsSegment(from, to)) {
                                    return true;
                                }
                                ++n3;
                            }
                        }
                        --x;
                    }
                    nextCurrentX = nextX;
                    ++y;
                }
            }
        } else {
            if (fromX > toX) {
                double t3 = toX;
                toX = fromX;
                fromX = t3;
                t3 = toY;
                toY = fromY;
                fromY = t3;
            }
            double m = (toY - fromY) / (toX - fromX);
            int fromXIdx = MathUtil.bound(this.idxForX(fromX), 0, this.width - 1);
            int toXIdx = MathUtil.bound(this.idxForX(toX), 0, this.width - 1);
            if (toY >= fromY) {
                int nextCurrentY = MathUtil.bound(this.idxForY((this.xForIdx(fromXIdx) - fromX) * m + fromY), 0, this.height - 1);
                int x = fromXIdx;
                while (x <= toXIdx) {
                    int currentY = nextCurrentY;
                    int nextY = MathUtil.bound(this.idxForY((this.xForIdx(x + 1) - fromX) * m + fromY), 0, this.height - 1);
                    int y = currentY;
                    while (y <= nextY) {
                        FixedArrayList<T> bin = this.grid[x][y];
                        if (bin != null) {
                            AbstractRectangleObject[] abstractRectangleObjectArray = (AbstractRectangleObject[])bin.rawArray();
                            int n = abstractRectangleObjectArray.length;
                            int n4 = 0;
                            while (n4 < n) {
                                AbstractRectangleObject rect = abstractRectangleObjectArray[n4];
                                if (rect.clipsSegment(from, to)) {
                                    return true;
                                }
                                ++n4;
                            }
                        }
                        ++y;
                    }
                    nextCurrentY = nextY;
                    ++x;
                }
            } else {
                int nextCurrentY = MathUtil.bound(this.idxForY((this.xForIdx(fromXIdx) - fromX) * m + fromY), 0, this.height - 1);
                int x = fromXIdx;
                while (x <= toXIdx) {
                    int currentY = nextCurrentY;
                    int nextY = MathUtil.bound(this.idxForY((this.xForIdx(x + 1) - fromX) * m + fromY), 0, this.height - 1);
                    int y = currentY;
                    while (y >= nextY) {
                        FixedArrayList<T> bin = this.grid[x][y];
                        if (bin != null) {
                            AbstractRectangleObject[] abstractRectangleObjectArray = (AbstractRectangleObject[])bin.rawArray();
                            int n = abstractRectangleObjectArray.length;
                            int n5 = 0;
                            while (n5 < n) {
                                AbstractRectangleObject rect = abstractRectangleObjectArray[n5];
                                if (rect.clipsSegment(from, to)) {
                                    return true;
                                }
                                ++n5;
                            }
                        }
                        --y;
                    }
                    nextCurrentY = nextY;
                    ++x;
                }
            }
        }
        return false;
    }

    public Collection<T> getClipping(Coord from, Coord to) {
        if (from.equals(to)) {
            return this.getColliding(from);
        }
        HashSet<AbstractRectangleObject> clipping = new HashSet<AbstractRectangleObject>();
        double fromX = from.x;
        double fromY = from.y;
        double toX = to.x;
        double toY = to.y;
        if (Math.abs(toY - fromY) > Math.abs(toX - fromX)) {
            if (fromY > toY) {
                double t2 = toX;
                toX = fromX;
                fromX = t2;
                t2 = toY;
                toY = fromY;
                fromY = t2;
            }
            double m = (toX - fromX) / (toY - fromY);
            int fromYIdx = MathUtil.bound(this.idxForY(fromY), 0, this.height - 1);
            int toYIdx = MathUtil.bound(this.idxForY(toY), 0, this.height - 1);
            if (toX >= fromX) {
                int nextCurrentX = MathUtil.bound(this.idxForX((this.yForIdx(fromYIdx) - fromY) * m + fromX), 0, this.width - 1);
                int y = fromYIdx;
                while (y <= toYIdx) {
                    int currentX = nextCurrentX;
                    int nextX = MathUtil.bound(this.idxForX((this.yForIdx(y + 1) - fromY) * m + fromX), 0, this.width - 1);
                    int x = currentX;
                    while (x <= nextX) {
                        FixedArrayList<T> bin = this.grid[x][y];
                        if (bin != null) {
                            AbstractRectangleObject[] abstractRectangleObjectArray = (AbstractRectangleObject[])bin.rawArray();
                            int n = abstractRectangleObjectArray.length;
                            int n2 = 0;
                            while (n2 < n) {
                                AbstractRectangleObject rect = abstractRectangleObjectArray[n2];
                                if (rect.clipsSegment(from, to)) {
                                    clipping.add(rect);
                                }
                                ++n2;
                            }
                        }
                        ++x;
                    }
                    nextCurrentX = nextX;
                    ++y;
                }
            } else {
                int nextCurrentX = MathUtil.bound(this.idxForX((this.yForIdx(fromYIdx) - fromY) * m + fromX), 0, this.width - 1);
                int y = fromYIdx;
                while (y <= toYIdx) {
                    int currentX = nextCurrentX;
                    int nextX = MathUtil.bound(this.idxForX((this.yForIdx(y + 1) - fromY) * m + fromX), 0, this.width - 1);
                    int x = currentX;
                    while (x >= nextX) {
                        FixedArrayList<T> bin = this.grid[x][y];
                        if (bin != null) {
                            AbstractRectangleObject[] abstractRectangleObjectArray = (AbstractRectangleObject[])bin.rawArray();
                            int n = abstractRectangleObjectArray.length;
                            int n3 = 0;
                            while (n3 < n) {
                                AbstractRectangleObject rect = abstractRectangleObjectArray[n3];
                                if (rect.clipsSegment(from, to)) {
                                    clipping.add(rect);
                                }
                                ++n3;
                            }
                        }
                        --x;
                    }
                    nextCurrentX = nextX;
                    ++y;
                }
            }
        } else {
            if (fromX > toX) {
                double t3 = toX;
                toX = fromX;
                fromX = t3;
                t3 = toY;
                toY = fromY;
                fromY = t3;
            }
            double m = (toY - fromY) / (toX - fromX);
            int fromXIdx = MathUtil.bound(this.idxForX(fromX), 0, this.width - 1);
            int toXIdx = MathUtil.bound(this.idxForX(toX), 0, this.width - 1);
            if (toY >= fromY) {
                int nextCurrentY = MathUtil.bound(this.idxForY((this.xForIdx(fromXIdx) - fromX) * m + fromY), 0, this.height - 1);
                int x = fromXIdx;
                while (x <= toXIdx) {
                    int currentY = nextCurrentY;
                    int nextY = MathUtil.bound(this.idxForY((this.xForIdx(x + 1) - fromX) * m + fromY), 0, this.height - 1);
                    int y = currentY;
                    while (y <= nextY) {
                        FixedArrayList<T> bin = this.grid[x][y];
                        if (bin != null) {
                            AbstractRectangleObject[] abstractRectangleObjectArray = (AbstractRectangleObject[])bin.rawArray();
                            int n = abstractRectangleObjectArray.length;
                            int n4 = 0;
                            while (n4 < n) {
                                AbstractRectangleObject rect = abstractRectangleObjectArray[n4];
                                if (rect.clipsSegment(from, to)) {
                                    clipping.add(rect);
                                }
                                ++n4;
                            }
                        }
                        ++y;
                    }
                    nextCurrentY = nextY;
                    ++x;
                }
            } else {
                int nextCurrentY = MathUtil.bound(this.idxForY((this.xForIdx(fromXIdx) - fromX) * m + fromY), 0, this.height - 1);
                int x = fromXIdx;
                while (x <= toXIdx) {
                    int currentY = nextCurrentY;
                    int nextY = MathUtil.bound(this.idxForY((this.xForIdx(x + 1) - fromX) * m + fromY), 0, this.height - 1);
                    int y = currentY;
                    while (y >= nextY) {
                        FixedArrayList<T> bin = this.grid[x][y];
                        if (bin != null) {
                            AbstractRectangleObject[] abstractRectangleObjectArray = (AbstractRectangleObject[])bin.rawArray();
                            int n = abstractRectangleObjectArray.length;
                            int n5 = 0;
                            while (n5 < n) {
                                AbstractRectangleObject rect = abstractRectangleObjectArray[n5];
                                if (rect.clipsSegment(from, to)) {
                                    clipping.add(rect);
                                }
                                ++n5;
                            }
                        }
                        --y;
                    }
                    nextCurrentY = nextY;
                    ++x;
                }
            }
        }
        return clipping;
    }

    public boolean isClipping_ignore(Coord from, Coord to, T ignoreRect) {
        if (from.equals(to)) {
            return this.collides_ignore(from, ignoreRect);
        }
        if (from.equals(to)) {
            return this.collidesAny(from);
        }
        double fromX = from.x;
        double fromY = from.y;
        double toX = to.x;
        double toY = to.y;
        if (Math.abs(toY - fromY) > Math.abs(toX - fromX)) {
            if (fromY > toY) {
                double t2 = toX;
                toX = fromX;
                fromX = t2;
                t2 = toY;
                toY = fromY;
                fromY = t2;
            }
            double m = (toX - fromX) / (toY - fromY);
            int fromYIdx = MathUtil.bound(this.idxForY(fromY), 0, this.height - 1);
            int toYIdx = MathUtil.bound(this.idxForY(toY), 0, this.height - 1);
            if (toX >= fromX) {
                int nextCurrentX = MathUtil.bound(this.idxForX((this.yForIdx(fromYIdx) - fromY) * m + fromX), 0, this.width - 1);
                int y = fromYIdx;
                while (y <= toYIdx) {
                    int currentX = nextCurrentX;
                    int nextX = MathUtil.bound(this.idxForX((this.yForIdx(y + 1) - fromY) * m + fromX), 0, this.width - 1);
                    int x = currentX;
                    while (x <= nextX) {
                        FixedArrayList<T> bin = this.grid[x][y];
                        if (bin != null) {
                            AbstractRectangleObject[] abstractRectangleObjectArray = (AbstractRectangleObject[])bin.rawArray();
                            int n = abstractRectangleObjectArray.length;
                            int n2 = 0;
                            while (n2 < n) {
                                AbstractRectangleObject rect = abstractRectangleObjectArray[n2];
                                if (ignoreRect != rect && rect.clipsSegment(from, to)) {
                                    return true;
                                }
                                ++n2;
                            }
                        }
                        ++x;
                    }
                    nextCurrentX = nextX;
                    ++y;
                }
            } else {
                int nextCurrentX = MathUtil.bound(this.idxForX((this.yForIdx(fromYIdx) - fromY) * m + fromX), 0, this.width - 1);
                int y = fromYIdx;
                while (y <= toYIdx) {
                    int currentX = nextCurrentX;
                    int nextX = MathUtil.bound(this.idxForX((this.yForIdx(y + 1) - fromY) * m + fromX), 0, this.width - 1);
                    int x = currentX;
                    while (x >= nextX) {
                        FixedArrayList<T> bin = this.grid[x][y];
                        if (bin != null) {
                            AbstractRectangleObject[] abstractRectangleObjectArray = (AbstractRectangleObject[])bin.rawArray();
                            int n = abstractRectangleObjectArray.length;
                            int n3 = 0;
                            while (n3 < n) {
                                AbstractRectangleObject rect = abstractRectangleObjectArray[n3];
                                if (ignoreRect != rect && rect.clipsSegment(from, to)) {
                                    return true;
                                }
                                ++n3;
                            }
                        }
                        --x;
                    }
                    nextCurrentX = nextX;
                    ++y;
                }
            }
        } else {
            if (fromX > toX) {
                double t3 = toX;
                toX = fromX;
                fromX = t3;
                t3 = toY;
                toY = fromY;
                fromY = t3;
            }
            double m = (toY - fromY) / (toX - fromX);
            int fromXIdx = MathUtil.bound(this.idxForX(fromX), 0, this.width - 1);
            int toXIdx = MathUtil.bound(this.idxForX(toX), 0, this.width - 1);
            if (toY >= fromY) {
                int nextCurrentY = MathUtil.bound(this.idxForY((this.xForIdx(fromXIdx) - fromX) * m + fromY), 0, this.height - 1);
                int x = fromXIdx;
                while (x <= toXIdx) {
                    int currentY = nextCurrentY;
                    int nextY = MathUtil.bound(this.idxForY((this.xForIdx(x + 1) - fromX) * m + fromY), 0, this.height - 1);
                    int y = currentY;
                    while (y <= nextY) {
                        FixedArrayList<T> bin = this.grid[x][y];
                        if (bin != null) {
                            AbstractRectangleObject[] abstractRectangleObjectArray = (AbstractRectangleObject[])bin.rawArray();
                            int n = abstractRectangleObjectArray.length;
                            int n4 = 0;
                            while (n4 < n) {
                                AbstractRectangleObject rect = abstractRectangleObjectArray[n4];
                                if (ignoreRect != rect && rect.clipsSegment(from, to)) {
                                    return true;
                                }
                                ++n4;
                            }
                        }
                        ++y;
                    }
                    nextCurrentY = nextY;
                    ++x;
                }
            } else {
                int nextCurrentY = MathUtil.bound(this.idxForY((this.xForIdx(fromXIdx) - fromX) * m + fromY), 0, this.height - 1);
                int x = fromXIdx;
                while (x <= toXIdx) {
                    int currentY = nextCurrentY;
                    int nextY = MathUtil.bound(this.idxForY((this.xForIdx(x + 1) - fromX) * m + fromY), 0, this.height - 1);
                    int y = currentY;
                    while (y >= nextY) {
                        FixedArrayList<T> bin = this.grid[x][y];
                        if (bin != null) {
                            AbstractRectangleObject[] abstractRectangleObjectArray = (AbstractRectangleObject[])bin.rawArray();
                            int n = abstractRectangleObjectArray.length;
                            int n5 = 0;
                            while (n5 < n) {
                                AbstractRectangleObject rect = abstractRectangleObjectArray[n5];
                                if (ignoreRect != rect && rect.clipsSegment(from, to)) {
                                    return true;
                                }
                                ++n5;
                            }
                        }
                        --y;
                    }
                    nextCurrentY = nextY;
                    ++x;
                }
            }
        }
        return false;
    }

    public int width() {
        return this.width;
    }

    public int height() {
        return this.height;
    }

    public int idxForX(double x) {
        return (int)((x - this.tl.x) / this.gridSize_mm);
    }

    public int idxForY(double y) {
        return (int)((y - this.tl.y) / this.gridSize_mm);
    }

    public double xForIdx(int idx) {
        return this.tl.x + (double)idx * this.gridSize_mm;
    }

    public double yForIdx(int idx) {
        return this.tl.y + (double)idx * this.gridSize_mm;
    }

    public FixedArrayList<T> binAt(int x, int y, boolean createIfNotExists) {
        if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
            return null;
        }
        FixedArrayList<T> ret = this.grid[x][y];
        if (createIfNotExists && ret == null) {
            this.grid[x][y] = ret = new FixedArrayList<T>(this.clazz);
        }
        return ret;
    }
}

