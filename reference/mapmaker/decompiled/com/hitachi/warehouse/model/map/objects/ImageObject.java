/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.map.objects;

import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import com.hitachi.warehouse.model.map.objects.AbstractRectangleObject;
import common.gui.ImageUtil;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.awt.image.RenderedImage;
import java.io.IOException;
import java.io.ObjectInputStream;
import java.io.ObjectOutputStream;
import javax.imageio.ImageIO;

public class ImageObject
extends AbstractRectangleObject {
    private static final long serialVersionUID = 4893563351180090986L;
    private transient BufferedImage image = null;

    @Override
    public boolean isObstructing() {
        return false;
    }

    public void setImage(BufferedImage image) {
        this.image = image;
    }

    public BufferedImage getImage() {
        return this.image;
    }

    @Override
    public void paint(Graphics2D g, MapView mapView) {
        int fromX = mapView.screenXForWorld(this.tl().x);
        int fromY = mapView.screenYForWorld(this.tl().y);
        int toX = mapView.screenXForWorld(this.br().x);
        int toY = mapView.screenYForWorld(this.br().y);
        if (this.image != null) {
            g.drawImage(this.image, fromX, fromY, toX - fromX, toY - fromY, null);
        }
    }

    public String toString() {
        return "Image:";
    }

    private void writeObject(ObjectOutputStream out) throws IOException {
        out.defaultWriteObject();
        ImageIO.write((RenderedImage)this.image, "png", out);
    }

    private void readObject(ObjectInputStream in) throws IOException, ClassNotFoundException {
        in.defaultReadObject();
        this.image = ImageIO.read(in);
    }

    @Override
    public AbstractObject hardClone() {
        ImageObject newObj = new ImageObject();
        newObj.image = ImageUtil.cloneImage(this.image);
        newObj.setBounds(this.tl(), this.br());
        return newObj;
    }
}

